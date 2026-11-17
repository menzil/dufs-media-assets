import {
  AppendOnlyStreamTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  InputDisposedError,
  MATROSKA,
  Mp4OutputFormat,
  Output,
  UrlSource,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
} from "mediabunny";

type RemuxTrack = Readonly<{
  sink: EncodedPacketSink;
  mimeType: string;
  connect: (output: Output) => (packet: EncodedPacket) => Promise<void>;
}>;

export type MkvPlayback = Readonly<{
  ready: Promise<void>;
  signal: AbortSignal;
  dispose: () => void;
}>;

const BUFFER_AHEAD_SECONDS = 20;
const BUFFER_BEHIND_SECONDS = 30;

async function prepareVideoTrack(track: InputVideoTrack): Promise<RemuxTrack> {
  const codec = await track.getCodec();
  const decoderConfig = await track.getDecoderConfig();
  if (codec === null || decoderConfig === null) {
    throw new Error("The MKV video track has an unrecognized codec");
  }
  const transformationMatrix = await track.getTransformationMatrix();
  return {
    sink: new EncodedPacketSink(track),
    mimeType: `video/mp4; codecs="${decoderConfig.codec}"`,
    connect(output: Output): (packet: EncodedPacket) => Promise<void> {
      const source = new EncodedVideoPacketSource(codec);
      output.addVideoTrack(source, { decoderConfig, transformationMatrix });
      return (packet: EncodedPacket): Promise<void> => source.add(packet);
    },
  };
}

async function prepareAudioTrack(track: InputAudioTrack): Promise<RemuxTrack> {
  const codec = await track.getCodec();
  const decoderConfig = await track.getDecoderConfig();
  if (codec === null || decoderConfig === null) {
    throw new Error("The MKV audio track has an unrecognized codec");
  }
  return {
    sink: new EncodedPacketSink(track),
    mimeType: `audio/mp4; codecs="${decoderConfig.codec}"`,
    connect(output: Output): (packet: EncodedPacket) => Promise<void> {
      const source = new EncodedAudioPacketSource(codec);
      output.addAudioTrack(source, { decoderConfig });
      return (packet: EncodedPacket): Promise<void> => source.add(packet);
    },
  };
}

function waitForEvent(target: EventTarget, name: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      target.removeEventListener(name, complete);
      signal.removeEventListener("abort", abort);
    }
    function complete(): void {
      cleanup();
      resolve();
    }
    function abort(): void {
      cleanup();
      reject(signal.reason);
    }
    target.addEventListener(name, complete, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}

function updateBuffer(buffer: SourceBuffer, operation: () => void, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      buffer.removeEventListener("updateend", complete);
      buffer.removeEventListener("error", failed);
      signal.removeEventListener("abort", abort);
    }
    function complete(): void {
      cleanup();
      resolve();
    }
    function failed(): void {
      cleanup();
      reject(new Error("The browser could not decode the MKV media fragments"));
    }
    function abort(): void {
      cleanup();
      if (buffer.updating) {
        buffer.abort();
      }
      reject(signal.reason);
    }
    buffer.addEventListener("updateend", complete, { once: true });
    buffer.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    try {
      operation();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function containsTime(ranges: TimeRanges, timestamp: number): boolean {
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= timestamp && timestamp < ranges.end(index)) {
      return true;
    }
  }
  return false;
}

async function streamTrack(
  track: RemuxTrack,
  buffer: SourceBuffer,
  video: HTMLVideoElement,
  timestamp: number,
  signal: AbortSignal,
): Promise<void> {
  if (buffer.buffered.length > 0) {
    await updateBuffer(buffer, () => buffer.remove(0, Infinity), signal);
  }
  const first = await track.sink.getFirstKeyPacket();
  if (first === null) {
    throw new Error(`The MKV track contains no playable key packets: ${track.mimeType}`);
  }
  const start = timestamp <= first.timestamp ? first : await track.sink.getKeyPacket(timestamp);
  if (start === null) {
    throw new Error(`The MKV track has no key packet at ${timestamp} seconds: ${track.mimeType}`);
  }
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
    target: new AppendOnlyStreamTarget(new WritableStream<Uint8Array>({
      async write(data: Uint8Array): Promise<void> {
        signal.throwIfAborted();
        // A fragment is emitted at the next keyframe, so throttle completed fragments rather than input packets.
        while (buffer.buffered.length > 0
          && buffer.buffered.end(buffer.buffered.length - 1) > video.currentTime + BUFFER_AHEAD_SECONDS) {
          await waitForEvent(video, "timeupdate", signal);
        }
        const removeBefore = video.currentTime - BUFFER_BEHIND_SECONDS;
        if (buffer.buffered.length > 0 && buffer.buffered.start(0) < removeBefore) {
          const boundary = await track.sink.getKeyPacket(removeBefore);
          if (boundary === null) {
            throw new Error(`The MKV track has no key packet before ${removeBefore} seconds: ${track.mimeType}`);
          }
          if (buffer.buffered.start(0) < boundary.timestamp) {
            await updateBuffer(buffer, () => buffer.remove(0, boundary.timestamp), signal);
          }
        }
        await updateBuffer(buffer, () => buffer.appendBuffer(new Uint8Array(data)), signal);
      },
    })),
  });
  const addPacket = track.connect(output);
  try {
    await output.start();
    for await (const packet of track.sink.packets(start)) {
      signal.throwIfAborted();
      await addPacket(packet);
    }
    signal.throwIfAborted();
    await output.finalize();
  } finally {
    if (output.state !== "finalized") {
      await output.cancel();
    }
  }
}

/** Streams MKV tracks as fragmented MP4, retaining native video controls without transcoding. */
export function createMkvPlayback(
  video: HTMLVideoElement,
  url: string,
  onError: (error: Error) => void,
): MkvPlayback {
  const lifetime = new AbortController();
  const input = new Input({
    formats: [MATROSKA],
    source: new UrlSource(url, {
      maxCacheSize: 16 * 1024 * 1024,
      async fetchFn(resource, options): Promise<Response> {
        const request = new Request(resource, options);
        const response = await fetch(request);
        if (!response.ok) {
          throw new Error(
            `MKV request failed: ${request.method} ${request.url}; Range=${request.headers.get("Range")}; `
            + `HTTP ${response.status} ${response.statusText}; body=${await response.text()}`,
          );
        }
        return response;
      },
      getRetryDelay(attempt: number, error, requestUrl: string | URL | Request): number | null {
        if (attempt > 2) {
          return null;
        }
        console.warn("Retrying MKV request", { attempt, url: requestUrl, error });
        return attempt;
      },
      handleUnhandledError(error): void {
        if (!lifetime.signal.aborted) {
          dispose();
          onError(new Error(`MKV request failed: ${url}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          }));
        }
      },
    }),
  });
  let mediaUrl: string | null = null;
  let streaming: Promise<void> = Promise.resolve();
  let currentStream: AbortController | null = null;

  function dispose(): void {
    lifetime.abort();
    currentStream?.abort();
    input.dispose();
    if (mediaUrl !== null) {
      URL.revokeObjectURL(mediaUrl);
      mediaUrl = null;
    }
  }

  async function initialize(): Promise<void> {
    if (typeof MediaSource === "undefined") {
      throw new Error("This browser does not support Media Source Extensions required for MKV playback");
    }
    const videoTrack = await input.getPrimaryVideoTrack();
    if (videoTrack === null) {
      throw new Error(`The MKV file contains no video track: ${url}`);
    }
    const audioTrack = await input.getPrimaryAudioTrack();
    const tracks: RemuxTrack[] = [await prepareVideoTrack(videoTrack)];
    if (audioTrack !== null) {
      tracks.push(await prepareAudioTrack(audioTrack));
    }
    for (const track of tracks) {
      if (!MediaSource.isTypeSupported(track.mimeType)) {
        throw new Error(`This browser cannot play the MKV track encoding: ${track.mimeType}`);
      }
    }
    const trackEndTimes = await Promise.all((audioTrack === null ? [videoTrack] : [videoTrack, audioTrack])
      .map((track) => input.computeDuration([track])));
    if (trackEndTimes.some((end: number) => !Number.isFinite(end) || end <= 0)) {
      throw new Error(`The MKV tracks have invalid end times: ${trackEndTimes.join(", ")} seconds: ${url}`);
    }
    if (Math.max(...trackEndTimes) - Math.min(...trackEndTimes) > BUFFER_AHEAD_SECONDS) {
      throw new Error(
        `The MKV audio and video tracks end more than ${BUFFER_AHEAD_SECONDS} seconds apart `
        + `(${trackEndTimes.join(", ")} seconds). Remux the file with matching track lengths to play it in this browser`,
      );
    }
    const duration = Math.max(...trackEndTimes);
    lifetime.signal.throwIfAborted();
    const mediaSource = new MediaSource();
    const opened = waitForEvent(mediaSource, "sourceopen", lifetime.signal);
    mediaUrl = URL.createObjectURL(mediaSource);
    video.src = mediaUrl;
    video.load();
    await opened;
    mediaSource.duration = duration;
    const buffers = tracks.map((track: RemuxTrack) => mediaSource.addSourceBuffer(track.mimeType));

    function startStream(timestamp: number): void {
      currentStream?.abort();
      const controller = new AbortController();
      currentStream = controller;
      streaming = streaming.then(async () => {
        controller.signal.throwIfAborted();
        const jobs = tracks.map((track: RemuxTrack, index: number) => {
          const buffer = buffers[index];
          if (buffer === undefined) {
            throw new Error(`Missing MKV source buffer for track ${index}`);
          }
          return streamTrack(track, buffer, video, timestamp, controller.signal);
        });
        try {
          await Promise.all(jobs);
          controller.signal.throwIfAborted();
          mediaSource.endOfStream();
        } finally {
          controller.abort();
          await Promise.allSettled(jobs);
        }
      }).catch((error) => {
        if (error === controller.signal.reason || error === lifetime.signal.reason) {
          return;
        }
        if (lifetime.signal.aborted && error instanceof InputDisposedError) {
          return;
        }
        dispose();
        onError(new Error(`Unable to play MKV ${url}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        }));
      });
    }

    video.addEventListener("seeking", () => {
      if (!buffers.every((buffer: SourceBuffer) => containsTime(buffer.buffered, video.currentTime))) {
        startStream(video.currentTime);
      }
    }, { signal: lifetime.signal });
    startStream(0);
  }

  return { ready: initialize(), signal: lifetime.signal, dispose };
}
