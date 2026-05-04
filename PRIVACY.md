# Privacy Policy — Reonomy Side Panel

_Last updated: 2026-05-03_

This Chrome extension ("the extension") is a personal productivity tool for users of Reonomy who want to look up publicly-available contact information for property owners they are already viewing on Reonomy. This document explains what data the extension reads, where it is sent, and how it is stored.

## What the extension reads

When you are viewing a property page on `https://app.reonomy.com/`, the extension's content script reads owner names, owner addresses, and other property details that are already displayed to you on the page. The extension does not read any data from any other site, and it does not read any data while you are not on a Reonomy property page.

## What the extension sends

When you explicitly click the "Find contacts" button in the side panel, the extension performs lookups on two public people-search websites that you could equivalently visit yourself:

- TruePeopleSearch (`https://www.truepeoplesearch.com/`)
- FamilyTreeNow (`https://www.familytreenow.com/`)

Lookups consist only of the owner names and addresses that the extension read from the Reonomy page you are viewing. The extension does not send any data to any other server, and it does not send the data anywhere except to those two public people-search sites and only when you have clicked the button.

The extension does not have its own backend server. There is no analytics, telemetry, error reporting, or third-party data collection of any kind.

## What the extension stores

To avoid repeating identical lookups when you re-visit the same property, the extension caches successful lookup results in `chrome.storage.local`. This data lives only in your local Chrome profile on your computer. It is not synced, transmitted, or shared. You can clear it at any time by removing the extension or by calling `chrome.storage.local.clear()` from the side panel's developer console.

## What the extension does not do

- Does not collect, transmit, or store any login credentials.
- Does not read any pages other than `https://app.reonomy.com/*/property/*` and the people-search pages it visits on your behalf.
- Does not track your browsing activity outside the explicit lookup flow.
- Does not share any data with any party other than the people-search sites listed above.

## Permissions, in plain English

The extension requests these Chrome permissions for these specific reasons:

- `sidePanel` — to render the side panel UI.
- `activeTab`, `tabs`, `webNavigation` — to detect when you navigate to a Reonomy property page so the side panel can show data for that property.
- `scripting` — to inject the content script that reads owner data from the Reonomy page.
- `storage` — to cache successful lookup results in `chrome.storage.local`.
- `declarativeNetRequestWithHostAccess` — to set request headers required by the people-search sites' own server-side checks; no traffic is redirected to any third party.
- Host permissions for `app.reonomy.com`, `www.truepeoplesearch.com`, and `www.familytreenow.com` — limited to those three domains, the only sites the extension interacts with.

## Contact

For privacy questions, contact: kyberlind@gmail.com
