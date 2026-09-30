# Testing Center Coversheets

Fill in one assessment's shared details once, add every student taking it, and print a full stack of individual testing-center coversheets — one page per student, formatted to match Horace Mann's coversheet.

Runs entirely in the browser: no server, no accounts, nothing uploaded. Everything you type lives only in that browser tab's memory and is gone when you close or reload the page. "Print all coversheets" calls the browser's own print dialog, so "Save as PDF" works too without this tool generating a PDF itself.

## Use it

Open `index.html` (works from any static file host, or just double-click it locally) — or use the hosted version via GitHub Pages once enabled for this repo.

## How it's built

Single static HTML file, no build step, no dependencies beyond two Google Fonts. All logic is inline `<script>`/`<style>` in `index.html` — there's no separate, hidden build; what's in this file is exactly what runs in the browser.
