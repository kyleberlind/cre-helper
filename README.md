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

The side panel shows owner cards (phones, emails, addresses) and the Reported Owner block. Click **Find contacts** on the CTA strip to fan out lookups against TruePeopleSearch and FamilyTreeNow; results cache to `chrome.storage.local` so re-visiting a property short-circuits the network calls and shows a green "Contacts found" badge.

## Requirements

- Node 20+
- Chrome 114+ (Side Panel API).

## Notes

- Reonomy's DOM isn't a public contract, so the parser uses generic structural signals (labeled key/value pairs, definition lists, tables, page text).
- Host permissions cover `app.reonomy.com`, `www.truepeoplesearch.com`, and `www.familytreenow.com`. The latter two are visited as hidden tabs only when you click **Find contacts**.
- Icons live in `public/icons/` and ship to `dist/icons/` via `@crxjs/vite-plugin`'s `public/` copy.
