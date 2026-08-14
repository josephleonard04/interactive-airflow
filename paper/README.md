# Paper — CHI 2027 submission

**Deadline: 10 September 2026, Anywhere on Earth.** Revise & Resubmit 3 December
2026. Conference 10–14 May 2027, Pittsburgh.

## Getting it into Overleaf

Overleaf's free tier has no git access, so the route is a one-time upload:

1. In your Overleaf project, **File tree → upload icon** (the arrow, top left).
2. Drag in `main.tex` and `refs.bib`. Overwrite the existing `main.tex`.
3. **Menu → Settings → Compiler: pdfLaTeX**, and set the main document to
   `main.tex`.
4. Recompile. The `acmart` class is already installed on Overleaf — nothing to
   download.

If you later get Overleaf Premium, the project gains a git remote
(`https://git.overleaf.com/<project-id>`) and this directory can be pushed
directly instead.

## Format notes

CHI 2027 requires submissions to be **anonymized** and in **single-column**
format for review, so the class options are:

```latex
\documentclass[manuscript,review,anonymous]{acmart}
```

The real author block is in `main.tex`, commented out, immediately after
`\title`. For the camera-ready, switch to `\documentclass[sigconf]{acmart}` and
uncomment it.

**Length:** 5,000–8,000 words excluding references is encouraged. Over 12,000
is desk-rejected without justification.

## What still needs you

Search `main.tex` for `TODO(Joseph)` and `PENDING`.

- **Results, Discussion, Conclusion** — scaffolded with the analysis plan but
  empty. Drop the 15 session JSONs somewhere in this repo and they can be
  analysed and written.
- **Your affiliation** — I used Virginia Tech, inferred from `josephl04@vt.edu`.
  Change it if the work should be credited to the UTokyo visit.
- **Participant demographics** — the age bands are currently prose ("a few
  teenagers, a majority in their twenties"). Numbers are better.
- **Ethics statement** — needs the approval reference from the UTokyo GSIST
  review, plus recruitment channel and compensation.
- **The `mackay2023doit` citation** — check the exact title, publisher and year
  against the PDF you have. I could not verify it.
- **CCS concepts** — regenerate the official block at <https://dl.acm.org/ccs>
  and paste it in. The current one is a reasonable guess.
- **Figures** — there are none yet. A CHI systems paper needs at least a teaser
  showing the three input modalities and one showing a before/after flow field.

## Sections that are done

Introduction, Related Work, Formative Study and Design Rationale, the system
description, the optimizer, Technical Evaluation, User Study method,
Limitations. Every number in the Technical Evaluation was measured on the
current build — see the commit history for the sweeps that produced them.
