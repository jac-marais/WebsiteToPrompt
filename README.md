# WebsiteToPrompt

A free, open-source Chrome extension that helps you convert webpage content into well-formatted prompts for ChatGPT or any other AI tool. It preserves headers, lists, links, and other text formatting, ensuring your AI conversations remain clear and structured.

## 1. Generating Prompts from Any Webpage
![Screenshot of an article page. The first section has become a dark Markdown card with a yellow top edge, a "Saved" status, and Copy Markdown, Restore, and Open in Saved prompts buttons. The yellow selection box outlines the next section, and the path bar at the bottom reads "2/3 body › main › section#steps".](screenshot-webpage.png)

## 2. Sorting, Searching, and Visiting Snippets
![Screenshot of the Saved prompts page. Websites are listed on the left, two prompts from docs.example.com are checked in the middle with a "Copy as one prompt (2)" button, and the right panel shows the "Rate limits" prompt with its source link and a Copy Markdown button.](screenshot-dashboard.png)

## Features

1. **One-Click Selection**:
   - Choose **Select content**, then hover over any paragraph, list, or section.
   - Click to capture content, automatically converting it to clean Markdown.
   - Retains original layout without random line breaks or missing headers.
   - The selection box and the Markdown card keep their look on any site, even above an open site dialog.

2. **Saved Prompts**:
   - Each selected snippet saves to your saved prompts within the extension, and the card on the page says when the save is done.
   - Uses Chrome's local storage - no complicated setup needed.
   - Everything stays on your device unless explicitly copied elsewhere.

3. **Saved Prompts Page**:
   - Group prompts by website or capture date
   - Search the text or the website address
   - Tick several prompts to copy them as one prompt or delete them
   - View, manage, and export your saved content
   - Follows your system's light or dark mode

4. **Format Preservation**:
   - Maintains headers, lists, and clickable links
   - Clean, structured output for better AI processing
   - Perfect for ChatGPT, documentation, or research notes

5. **Privacy & Security**:
   - Open-source code available on GitHub
   - Local storage only - your data stays on your device
   - No personal information collected or sold

## Installation

1. Install from the Chrome Web Store
2. Pin the extension to your toolbar
3. Click the extension icon and choose **Select content** on any webpage
4. Start capturing content with a single click

## How to Use

1. Click the extension icon and choose **Select content** (or right-click the page and choose **Select content**)
2. Hover over the content you want. Scroll to widen the box to a bigger block or narrow it again. Press Esc to cancel
3. Click to capture. The element turns into a Markdown card that shows **Saving…** and then **✓ Saved**. If the save fails, the card says **Not saved. Copy it now.**
4. Use the card's buttons:
   - **Copy Markdown** copies the Markdown
   - **Restore** puts the original page section back. The saved prompt stays saved
   - **Open in Saved prompts** opens that prompt on the Saved prompts page
5. Open **Saved prompts** from the extension icon (or right-click the page and choose **Open saved prompts**) to:
   - Search by text or website
   - Copy one prompt's Markdown with **Copy Markdown**
   - Tick several prompts (or Shift-click a range) and choose **Copy as one prompt**. Each prompt is wrapped in a `<website_section>` tag with its source URL, newest first
   - Delete prompts you no longer need, after a confirmation

## Technical Details

- Built on [Turndown](https://github.com/domchristie/turndown) for HTML-to-Markdown conversion
- Uses Chrome's local storage API for data persistence
- Links and images are written with absolute URLs, and link text stays on one line
- The in-page UI lives in shadow roots, so the page's CSS cannot restyle it, and the selection box uses the browser's top layer (Chrome 114 or later)
- System fonts and local images only, so the extension makes no network requests of its own

## Development

There is no compile step. `src/` is the complete extension.

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `src/` (or `dist/` after `npm run build`).
2. After an edit, click the extension's reload button.
3. `npm run build` copies `src/` to `dist/`. `npm run pack` also writes `WebsiteToPrompt.zip` for the Chrome Web Store.
4. `npm test` loads `src/` into Playwright's Chromium inside Docker and runs `tests/e2e.js`: capture, links, restore, saves, the Saved prompts page, the popup, and the capture card on a plain page and on a page with hostile CSS and an open dialog.
5. The icons come from `src/icons/icon.svg`. To regenerate the PNGs, run:

   ```sh
   for icon_size in 16 32 48; do
     rsvg-convert -w "$icon_size" -h "$icon_size" src/icons/icon.svg -o "src/icons/icon-$icon_size.png"
   done
   rsvg-convert -w 96 -h 96 --page-width 128 --page-height 128 --left 16 --top 16 src/icons/icon.svg -o src/icons/icon-128.png
   ```
