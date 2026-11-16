# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/saifulsidik801-ship-it/markdown-render-speed-02-entry-v3/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/saifulsidik801-ship-it/markdown-render-speed-02-entry-v3/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown renderer written from scratch in JavaScript.
`parse(markdown)` returns exactly the HTML that marked 18.1.3 produces with
its default options (GFM on, breaks off), for every input — CommonMark 0.31.2
plus the GFM extensions (tables, task lists, strikethrough, autolinks,
disallowed raw HTML).

## Layout

- `parse.js` — the renderer. A dependency-free ES module exporting
  `parse(markdown)`: a block parser (paragraphs, ATX/setext headings, fenced
  and indented code, block quotes, lists, tables, HTML blocks, thematic
  breaks, link reference definitions) plus an inline parser (code spans,
  emphasis/strong emphasis with the delimiter stack, links, images,
  autolinks, entities, hard/soft breaks, raw HTML).
- `main.ts` — the harness driver. Reads every case from
  `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders each with
  `parse`, and writes the HTML array to `$MAKEFUN_OUTPUT_DIR/html.json`
  (default `/output`).

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

Node 22 (type stripping) or newer. No dependencies, no install step.

## License

MIT — see [LICENSE](LICENSE).
