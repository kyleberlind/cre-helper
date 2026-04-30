import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

// crxjs injects its own rollup output config and ignores user-supplied
// `entryFileNames` for HTML inputs, so the bundled sidepanel ends up as
// `sidepanel.html-<hash>.js`. Chrome's MIME sniffer sees `.html` inside the
// filename and serves it as application/octet-stream, which strict module
// loading rejects. Rename any `.html-*.js` bundle and patch references in
// the in-memory bundle before it's written to disk.
function stripHtmlFromChunkNames(): Plugin {
  return {
    name: "strip-html-from-chunk-names",
    enforce: "post",
    apply: "build",
    generateBundle(_options, bundle) {
      const renames = new Map<string, string>();
      for (const fileName of Object.keys(bundle)) {
        if (/\.html-[^/]*\.js$/.test(fileName)) {
          renames.set(fileName, fileName.replace(/\.html-/, "-"));
        }
      }
      if (renames.size === 0) return;
      for (const [oldName, newName] of renames) {
        const file = bundle[oldName];
        file.fileName = newName;
        bundle[newName] = file;
        delete bundle[oldName];
      }
      const replace = (s: string) => {
        for (const [oldName, newName] of renames) {
          if (s.includes(oldName)) s = s.split(oldName).join(newName);
        }
        return s;
      };
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk") {
          file.code = replace(file.code);
        } else if (typeof file.source === "string") {
          file.source = replace(file.source);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest: manifest as Parameters<typeof crx>[0]["manifest"] }),
    stripHtmlFromChunkNames(),
  ],
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
