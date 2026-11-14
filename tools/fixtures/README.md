# Test fixtures

Used by `npm run check:vellummap` (`tools/vellummap-check.ts`).

- `seorang.vellummap`: the sample city (`public/samples/seorang.cslmap.gz`) converted with Vellum's reference
  converter (`cargo run --release --example cslmap_to_vellummap -p parser-cslmap`, Vellum commit `8857666`).
  The check opens it next to the `.cslmap` and compares the two.
- `minimal-valid.vellummap`: Vellum's `packages/parser-cslmap/fixtures/minimal-valid.cslmap` converted the same
  way. Derived from Vellum, used under its MIT licence:

```
MIT License

Copyright (c) 2026 Sebastian Enrique Vargas Pizango

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Regenerate after a format change by converting the same inputs again.
