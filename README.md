# 📝 Examo v2

**Examo v2** is a powerful, AI-driven CLI application designed to automate the digitization of physical exam papers. It transforms raw PDFs into perfectly formatted, academic-standard `.docx` files using Google's Gemini Vision models and LaTeX.

---

## 🚀 Key Features

- **🧠 Intelligent Extraction**: Uses `gemini-1.5-flash` to transcribe exams with 100% fidelity, preserving intentional typos and academic nuances.
- **⚡ High-Concurrency Pipeline**: Map-Reduce style processing that chunks PDFs and processes them in parallel for maximum speed.
- **🎨 LaTeX-Grade Formatting**: Generates high-quality LaTeX code for complex structures (nested lists, phonetics, formulas) before compiling to Word.
- **🛠️ Automated Reassembly**: Intelligently organizes output by source PDF, preserving aspect ratios and ensuring perfect document structure.
- **📄 Sequential Organization**: Files are named sequentially (e.g., `01-English.docx`) and grouped by their source PDF for easy management.
- **📊 Detailed Summaries**: Generates a `SUMMARY.md` for each PDF and a master `SUMMARY.md` at the output root for quick reference and searchability.
- **📟 Premium TUI**: A beautiful, interactive terminal user interface built with `ink`.
- **🔄 Smart Recompilation**: Quick-fix mode to re-compile existing LaTeX files without re-running the full extraction.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (v20+)
- **Language**: TypeScript
- **TUI**: Ink (React for CLI)
- **AI**: Gemini Vision (via OpenRouter & Vercel AI SDK)
- **PDF Core**: Ghostscript / GraphicsMagick
- **Compilation**: Pandoc

---

## 📥 Installation

1. **Clone the repository**:

   ```bash
   git clone https://github.com/ifedayoprince/examov2.git
   cd examov2
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Install System Dependencies**:
   Ensure you have `pandoc` and `ghostscript` installed on your system.
   - **MacOS**: `brew install pandoc ghostscript`
   - **Windows**: `choco install pandoc ghostscript`

---

## ⚙️ Configuration

Create a `.env` file in the root directory:

```env
OPENROUTER_API_KEY=your_api_key_here
MODEL_NAME=google/gemini-3-flash-preview
CONCURRENCY_LIMIT=5
# MAX_CHUNKS=0 # set to a number to limit processing for testing
```

---

## 📖 Usage

### Standard Processing

Place your PDFs in the `input/` folder and run:

```bash
npm run build && node dist/cli.js
```

### Recompile Mode

To re-compile existing `.tex` files in the output directory:

```bash
node dist/cli.js --recompile
```

### Migration Script

If you have an old output structure and want to convert it to the new PDF-grouped structure with sequential naming:

```bash
node migrate.js
```

---

## 🔄 The Pipeline

1. **Ingestion**: PDFs are converted into high-resolution images while **preserving aspect ratio**.
2. **Chunking**: Images are grouped into logical subjects based on blank page boundaries.
3. **Map (Extraction)**: Gemini Vision extracts text and structures it into LaTeX-formatted JSON.
4. **Reduce (Assembly)**: The system groups files by source PDF and saves raw `.tex` files in a `tex/` subdirectory.
5. **Clean & Save**: A local cleaning process removes LaTeX artifacts and prepends standard exam headers.
6. **Compilation**: Pandoc uses a custom `template.docx` to generate sequential Word documents (e.g., `01-Subject.docx`).
7. **Summary**: Generates local and master `SUMMARY.md` files with first-question previews for easy searchability.

---

## 📄 License

MIT © [Ifedayo Oni](https://github.com/ifedayoprince)
