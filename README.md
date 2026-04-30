# cre-helper

A Chrome extension that reads property listing info from `https://app.reonomy.com/` and displays it in a side panel. Built with Vite + React + Tailwind.

## Setup

```sh
npm install
```

## Develop

```sh
npm run dev
```

This starts Vite in watch mode and writes the unpacked extension to `dist/`. Then:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and pick the `dist/` folder.
4. Pin the extension.

While `npm run dev` is running, edits to React components hot-reload in the side panel. Edits to `src/content.js` or `src/background.js` rebuild automatically — you may need to click the reload icon on the extension card to pick those up.

## Build for production

```sh
npm run build
```

Output goes to `dist/`. Load that folder as the unpacked extension.

## Layout

```
manifest.json              Extension manifest (paths point into src/)
src/
  background.js            Service worker — opens side panel, relays scrape data, refreshes on URL change
  content.js               Runs on /property/* pages, scrapes owner data, caches per propertyId
  sidepanel/
    index.html             Side panel entry (Vite picks this up via the manifest)
    main.tsx               React entry
    App.tsx                Top-level component: tabs, refresh, copy
    types.ts               TS types for the scrape payload
    index.css              Tailwind import + minimal globals
    components/            OwnerCard, ReportedOwnerCard, OwnersView, EmptyState
```

## Use

1. Navigate to a property page, e.g. `https://app.reonomy.com/!/property/<uuid>/ownership`.
2. The side panel auto-opens. It refreshes on every sub-tab change (Building / Ownership / Sales / etc.) and when you switch between Chrome tabs.
3. Owner data scraped from `/ownership` is cached per-property in `chrome.storage.local`, so it stays visible when you click over to other sub-tabs.

Two tabs:

- **Owners** — owner cards (phones, emails, addresses) plus the Reported Owner block.
- **Raw** — full scrape payload as JSON for debugging.

## Requirements

- Node 20+
- Chrome 114+ (Side Panel API).

## Notes

- Reonomy's DOM isn't a public contract, so the parser uses generic structural signals (labeled key/value pairs, definition lists, tables, page text). If a specific field is missing from **Owners**, the **Raw** tab will show what was scraped.
- Host permissions are scoped to `https://app.reonomy.com/*`.
- No icons bundled — Chrome shows a default puzzle-piece. Add PNGs and an `icons` block to `manifest.json` if you want custom art.
