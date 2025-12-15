# WebsiteToPrompt

A free, open-source Chrome extension that helps you convert webpage content into well-formatted prompts for ChatGPT or any other AI tool. It preserves headers, lists, links, and other text formatting, ensuring your AI conversations remain clear and structured.

## 1. Generating Prompts from Any Webpage
![Screenshot demonstrating how WebsiteToPrompt captures text from a Zapier blog post titled "What is ChatGPT?" and converts it into markdown prompts—preserving headings, lists, and links for seamless integration with AI tools.](screenshot-webpage.png)

## 2. Sorting, Searching, and Visiting Snippets
![Screenshot of the extension's prompt management dashboard, highlighting options to "Sort by URL" on the left sidebar, "Find by text" in the top search bar, and the ability to copy or delete prompts in bulk. "www.scad.edu" is shown as part of the user's private library, and a snippet from Zapier is displayed in the main panel.](screenshot-dashboard.png)

## Features

1. **One-Click Selection Mode**:
   - Toggle Selection Mode to hover over any paragraph, list, or section.
   - Click to capture content, automatically converting it to clean Markdown.
   - Retains original layout without random line breaks or missing headers.

2. **Personal Prompt Library**:
   - Each selected snippet saves to a private library within the extension.
   - Uses Chrome's local storage - no complicated setup needed.
   - Everything stays on your device unless explicitly copied elsewhere.

3. **Prompt Management Dashboard**:
   - Categorize prompts by website domain or capture date
   - Quick search and filter functionality
   - Bulk actions: Select multiple snippets to copy or delete
   - View, manage, and export your saved content

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
3. Enable Selection Mode on any webpage
4. Start capturing content with a single click

## How to Use

1. Click the extension icon
2. Toggle "Selection Mode"
3. Hover over desired content and click to capture
4. Access your saved prompts through the Dashboard where you can:
   - Search by URL or content
   - Delete unwanted prompts
   - Export selections in various formats
   - Combine multiple snippets into single prompts

## Technical Details

- Built on [Turndown](https://github.com/domchristie/turndown) for HTML-to-Markdown conversion
- Uses Chrome's local storage API for data persistence
