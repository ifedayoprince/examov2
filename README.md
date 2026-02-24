# 📝 Examo v2

**Examo v2** is a powerful, AI-driven CLI application designed to automate the digitization of physical exam papers. It transforms raw PDFs into perfectly formatted, academic-standard `.docx` files using Google's Gemini Vision models and LaTeX.

---

## 🚀 Key Features

- **🧠 Intelligent Extraction**: Uses `gemini-1.5-flash` to transcribe exams with 100% fidelity, preserving intentional typos and academic nuances.
- **⚡ High-Concurrency Pipeline**: Map-Reduce style processing that chunks PDFs and processes them in parallel for maximum speed.
- **🎨 LaTeX-Grade Formatting**: Generates high-quality LaTeX code for complex structures (nested lists, phonetics, formulas) before compiling to Word.
- **🛠️ Automated Reassembly**: Intelligently stitches content across page breaks and organizes output by Class and Subject.
- **📟 Premium TUI**: A beautiful, interactive terminal user interface built with `ink`.
- **🔄 Smart Recompilation**: Quick-fix mode to polish and re-compile existing LaTeX files without re-running the full extraction.

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
CHUNK_SIZE=10
```

---

## 📖 Usage

### Standard Processing

Place your PDFs in the `input/` folder and run:

```bash
npm run build && node dist/cli.js
```

Or specify custom directories:

```bash
node dist/cli.js --input ./my_exams --output ./final_results
```

### Recompile Mode

If you want to polish and re-compile existing `.tex` files in the output directory:

```bash
node dist/cli.js --recompile
```

---

## 🔄 The Pipeline

1. **Ingestion**: PDFs are converted into high-resolution JPEGs.
2. **Chunking**: Images are grouped into logical batches for parallel processing.
3. **Map (Extraction)**: Gemini Vision extracts text and structures it into LaTeX-formatted JSON.
4. **Reduce (Assembly)**: The system sorts pages, handles state (Class/Subject), and stitches the LaTeX content.
5. **Polish**: A final AI pass ensures consistent formatting and cleans up LaTeX artifacts.
6. **Compilation**: Pandoc uses a custom `template.docx` to generate the final Word documents.

---

## 📄 License

MIT © [Ifedayo Oni](https://github.com/ifedayoprince)
