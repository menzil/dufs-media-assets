# Dufs Media

Dufs Media is an image and video browser built on the official dufs `--assets` extension point. It replaces the default directory interface without modifying or forking the dufs server.

![Dufs Media demo](https://orhan.cn/images/dufs-media-library.jpeg)

## Features

- Responsive image and video thumbnails
- Full-screen image browsing and slideshows
- Native video playback with previous, next, and directory loop controls
- Persistent preview URLs that can be refreshed or shared
- Name, date, and size sorting
- Upload controls that follow dufs permissions
- Session upload log with progress and completion status
- Folder download when archive access is enabled

## Requirements

- A current Node.js release supported by the versions in `package.json`
- pnpm
- A dufs release that supports custom assets
- Rust and Chrome when running the end-to-end suite

## Build

```sh
pnpm install
pnpm build
```

The static assets are written to `dist/`.

## Use with dufs

Pass the build directory to dufs:

```sh
dufs /path/to/files --assets /path/to/dufs-media-assets/dist
```

dufs reads `dist/index.html` when it starts. Restart dufs after every rebuild so the server does not keep an old HTML file that references replaced hashed assets.

The upload button follows the `allow_upload` value injected by dufs. Enable uploads with the appropriate dufs `--allow-upload` or `-A` configuration. The button stays hidden for read-only users.

## Release archive

Build a ZIP whose root contains `index.html`, `favicon.ico`, and the `assets/` directory:

```sh
pnpm build
(cd dist && zip -r ../dufs-media-assets-v0.1.0.zip .)
shasum -a 256 dufs-media-assets-v0.1.0.zip > dufs-media-assets-v0.1.0.zip.sha256
```

Attach both files to the matching GitHub Release. Users can extract the archive into a directory and pass that directory to dufs with `--assets`.

## Verify

```sh
git clone https://github.com/sigoden/dufs.git dufs
git -C dufs checkout fe7fd564f80dfbac361c8e0589c3845638149d38
pnpm typecheck
pnpm test:e2e
```

The `dufs/` checkout is local test infrastructure and is ignored by this repository. The end-to-end suite builds that pinned official dufs revision, starts it against the test media, and verifies desktop, mobile, upload, and `--path-prefix` behavior in Chrome.

## Media compatibility

Image thumbnails use native browser loading and scaling. dufs does not expose a thumbnail generation API, so Dufs Media does not create a server-side thumbnail cache. Large libraries or original files may require a separate thumbnail service.

Video playback uses the browser's native player and HTTP Range requests. Dufs Media recognizes `mp4`, `m4v`, `mov`, `webm`, and `ogv` files. MOV files are loaded directly instead of being rejected through `canPlayType("video/quicktime")`; an H.264 MOV is covered by the Chrome end-to-end suite. Actual playback still depends on the container, codecs, and browser. Unsupported media produces an explicit error, with no silent transcoding or format fallback.
