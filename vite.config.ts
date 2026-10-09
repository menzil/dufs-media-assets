import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const BUILD_ASSET_MARKER = "/__DUFS_ASSET_BASE__/";

const developmentData = {
  href: "/旅行照片/",
  kind: "Index",
  uri_prefix: "/",
  allow_upload: false,
  allow_delete: false,
  allow_search: true,
  allow_archive: true,
  dir_exists: true,
  auth: true,
  user: "jin",
  paths: [
    { path_type: "Dir", name: "01 杭州", mtime: 1759852800000, size: 86 },
    { path_type: "Dir", name: "02 上海", mtime: 1759766400000, size: 42 },
    { path_type: "File", name: "README.txt", mtime: 1759680000000, size: 2480 },
  ],
};

function injectDevelopmentData(): Plugin {
  return {
    name: "inject-dufs-development-data",
    apply: "serve",
    transformIndexHtml(html: string): string {
      const encoded = Buffer.from(JSON.stringify(developmentData), "utf8").toString("base64");
      return html.replace("__INDEX_DATA__", encoded);
    },
  };
}

function normalizeDufsAssetUrls(): Plugin {
  return {
    name: "normalize-dufs-asset-urls",
    apply: "build",
    async closeBundle(): Promise<void> {
      const indexPath = resolve("dist/index.html");
      const html = await readFile(indexPath, "utf8");
      if (!html.includes(BUILD_ASSET_MARKER)) {
        throw new Error(`Build output is missing the asset path marker: ${BUILD_ASSET_MARKER}`);
      }
      await writeFile(indexPath, html.replaceAll(BUILD_ASSET_MARKER, "__ASSETS_PREFIX__"), "utf8");
    },
  };
}

export default defineConfig({
  base: BUILD_ASSET_MARKER,
  plugins: [injectDevelopmentData(), normalizeDufsAssetUrls()],
  build: {
    assetsDir: "assets",
    sourcemap: true,
  },
});
