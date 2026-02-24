# Product Requirements Document (PRD): Examo v2

## 1. Overview
Examo v2 is a CLI-based Text User Interface (TUI) application written in Node.js/TypeScript. It automates the digitization of physical exam papers by ingesting large PDFs, chunking them, concurrently processing them via Google's Gemini Flash vision model, and compiling perfectly formatted, logically separated `.docx` files using Pandoc.

## 2. Tech Stack Core
*   **Runtime:** Node.js (v20+)
*   **Language:** TypeScript
*   **TUI Framework:** `ink` (React for interactive CLI)
*   **AI Model:** `gemini-3-flash-preview` vision tasks using Vercel's AI sdk with OpenRouter.
*   **PDF Processing:** `pdf2pic` (wrapper for Ghostscript/GraphicsMagick to convert PDF pages to high-res JPEGs).
*   **Document Compilation:** `node-pandoc` (executing local Pandoc with the `template.docx` in the `files` directory).

## 3. Core Pipeline & Logic

To achieve high speed (concurrency) without breaking the logical flow of exams across pages, the pipeline must follow a Map-Reduce style pattern:

### Phase 1: Ingestion & Splitting
*   Read target PDFs from the configured `input/` folder.
*   Convert the PDF into individual image files (Page_1.jpg, Page_2.jpg, etc.).
*   Group images into logical chunks (e.g., 10 pages per chunk).

### Phase 2: Concurrent Extraction (The "Map" Phase)
*   Fire off API requests for all chunks **concurrently** (`Promise.all`). 
*   **Crucial Context Rule:** Because chunks run concurrently, Chunk 3 might finish before Chunk 2. The AI must tag each page in its JSON output with its actual Page Number.
*   The AI outputs a structured JSON array for its given pages.

### Phase 3: Synchronous Assembly (The "Reduce" Phase)
*   Wait for all chunks to finish.
*   Flatten and sort the JSON responses by Page Number (Page 1 to N).
*   Run a synchronous "State Machine" loop over the sorted pages:
    *   Track `currentClass` and `currentSubject`.
    *   If a page has a Header block, update the state.
    *   Append the generated LaTeX to `output_dir/currentClass/currentSubject.tex`.

### Phase 4: Compilation
*   Iterate through all generated `.tex` files.
*   Run Pandoc with the `template.docx` to generate the final Word documents.

---

## 4. The Prompt Engineering (The "Secret Sauce")

This is the most critical part of Examo v2. You will use **System Instructions** and a **JSON Schema** to strictly enforce your formatting rules.

**The System Prompt MUST contain these explicit rules:**
1.  **Strict Transcription (No Typos Fixed):** "You are a specialized exam transcription engine. You must transcribe the text EXACTLY as it appears. DO NOT correct spelling mistakes, punctuation, or grammatical errors. Some errors (e.g., 'Patrical', 'Imedietly') are intentional distractors for the students."
2.  **Fill-in-the-blanks:** "Convert any blank lines or underscores meant for user input into exactly five underscores: `_____`."
3.  **Exam Details Section:** "If you detect the Name, Subject, Class, and Date block, format it precisely using LaTeX. Bold the labels."
4.  **Section Demarcations:** "When you see headers like 'SECTION A (OBJECTIVES)' or 'SECTION B (ESSAY)' that are centralized, uppercase, and bold, format them in LaTeX using `\begin{center}\textbf{\uppercase{...}}\end{center}` or `\section*{...}`."
5.  **Nested Lists:** "Use LaTeX `enumerate` environments. Ensure top-level questions are numbers (`1., 2.`), second-level are lowercase letters in parentheses (`(a), (b)`), and third-level are lowercase roman numerals in parentheses (`(i), (ii)`). Use `\renewcommand{\theenumi...}` if necessary."
6.  **Phonetics:** "Properly transcribe phonetic symbols (e.g., `/ʃ/`, `/dʒ/`, `/s/`) using appropriate LaTeX packages (e.g., `tipa`) or standard unicode."
7.  **Columns:** "Read the pages strictly column by column (left column first, then right column)."

**The Required JSON Output Schema: (given in Zod)**
```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "page_number": { "type": "integer" },
      "detected_class": { "type": "string", "description": "e.g., JSS 1. If not found on this page, infer from context or leave null." },
      "detected_subject": { "type": "string", "description": "e.g., English Language. If not found, leave null." },
      "latex_content": { "type": "string", "description": "The fully formatted LaTeX code for this specific page." }
    },
    "required": ["page_number", "latex_content"]
  }
}
```

---

## 5. TUI Design (The "Banger" Interface)

Using `ink` (React for CLI), your interface should look something like this:

```text
=========================================================
                 E X A M O   v 2 . 0
=========================================================
⚙️  Config:
   Input Dir:  ./exam_pdfs/
   Output Dir: ./processed_docx/
   Model:      gemini-3-flash-preview

📄 Processing: SS_3_Mock_Exams.pdf (120 pages)
✂️  Splitting PDF into images... [Done]

🚀 Concurrent Extraction Engine Running (10 pages/chunk):
   Chunk 1 (Pgs 1-10):   ████████████████████████████████ 100% [Done]
   Chunk 2 (Pgs 11-20):  ██████████████████░░░░░░░░░░░░░░ 60%
   Chunk 3 (Pgs 21-30):  █████████████████████████░░░░░░░ 85%
   Chunk 4 (Pgs 31-40):  ██████████░░░░░░░░░░░░░░░░░░░░░░ 30%

🧠 Reassembling and stitching state...
   ↳ Detected JSS 1 - RNV...
   ↳ Detected JSS 1 - English...

📝 Compiling with Pandoc...
   JSS_1_RNV.docx      [✓]
   JSS_1_English.docx  [✓]

✨ Success! Processed 120 pages in 45 seconds.
```

## 6. Development Milestones

*   **Step 1: The Wrapper:** Build the TS script that takes a 2-page PDF, converts to JPG, sends to Gemini, and prints the raw JSON. Verify the prompt handles the intentional typos ("Imedietly") and phonetics perfectly.
*   **Step 2: The LaTeX Template:** Create a dummy `.tex` file with the exact nested list structures and sections, create your `template.docx` in Word (setting up margins and 2-column layout), and run standard Pandoc to ensure it compiles to look exactly like the school's format. Include `\usepackage{tipa}` in your LaTeX headers if using standard phonetic LaTeX.
*   **Step 3: Concurrency & State:** Implement the chunking logic. Run a 30-page PDF and verify that when the JSON is flattened, sentences that cut off on page 15 seamlessly continue on page 16 in the final `.tex` file.
*   **Step 4: The TUI:** Wrap the working logic in the `ink` terminal interface. Add the configuration step at startup to select input/output directories. 

This architecture guarantees you won't lose data across page breaks, fully utilizes the speed of LLM parallel processing, and rigidly forces the model to respect the school's exact academic formatting.