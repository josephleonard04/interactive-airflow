# Paper — CHI 2027 submission

**Papers deadline: 10 September 2026, Anywhere on Earth** (24-hour grace period
for edits only). Revise & Resubmit 3 December 2026. Conference 10–14 May 2027,
Pittsburgh.

Questions to `publications@chi2027.acm.org`.

## Format — what CHI 2027 actually requires

CHI 2027 uses the **ACM Primary Article Templates** with the **TAPS** publishing
workflow. That means the format you submit is *not* the format that gets
published, and the two stages have different settings:

| Stage | Format | Class options |
|---|---|---|
| **Initial submission** (what we are doing) | 1-column | `\documentclass[manuscript,review,anonymous]{acmart}` |
| Camera-ready, after conditional acceptance | 2-column | `\documentclass[sigconf]{acmart}` |

`main.tex` is already set to the submission line. `review` adds line numbers for
reviewers; `anonymous` prints "ANONYMOUS AUTHOR(S)". Verified in the build log:
`acmart Info: Using review mode`.

At camera-ready you upload source to TAPS, which generates both the 2-column PDF
and a responsive HTML5 version. You still approve the proofs.

## Anonymity — read this before uploading anything

CHI review is anonymous, **and authors submit the LaTeX source to PCS as well as
the PDF**. So author names must not be anywhere in the files you upload, not
even in comments.

The real author block therefore lives in **`authors.tex`, which is not part of
the submission**. `main.tex` has a commented-out `\input{authors}` and nothing
else identifying. Body text has been checked: no repo URL, no live-demo link, no
institution names, no "our prior work".

- **Submitting:** upload `main.tex` and `refs.bib`. **Not `authors.tex`.**
- **Camera-ready:** switch the class to `[sigconf]`, uncomment `\input{authors}`,
  include `authors.tex`.

Note the live demo and public repo would both deanonymize the submission. If you
want to cite the artifact, use an anonymized mirror (e.g. anonymous.4open.science)
and swap in the real link at camera-ready.

## Getting it into Overleaf

Overleaf's free tier has no git access, so it is a manual upload. Two routes:

**Simplest — upload our files.** In the Overleaf project: File tree → upload icon
→ drag in `main.tex` and `refs.bib`, overwriting the existing `main.tex`. Then
Menu → Compiler: **pdfLaTeX**, main document `main.tex`. `acmart` is preinstalled.

**Or start from ACM's template**, which is what CHI's own instructions describe:
open the [ACM Conference Proceedings Primary Article Template](https://www.overleaf.com/latex/templates/acm-conference-proceedings-master-template/pnrfvrrdbfwt)
as a template, delete `sigconf-lualatex.tex`, `sigconf-sigconf.tex`,
`sigconf-tagged.tex`, `sigconf-i13n.tex`, `sigconf.tex`, `acmart.pdf` and
`README.txt`, then paste our content into `sigconf-authordraft.tex`. Same result;
more steps.

## Length

- **5,000–8,000 words encouraged**, excluding references.
- Under 5,000 counts as a **short paper**.
- Over 12,000 is **desk-rejected** unless the length is justified.
- Reviewers are told to weigh contribution *relative to* length. Verbose writing
  is explicitly discouraged, so longer is not safer.

Current body: **4,373 words**, 10 pages. Under the encouraged band — Results,
Discussion and Conclusion are the gap.

Check it with `python ../scratchpad/wc.py main.tex` or Overleaf's word count.

## Figures — none placed yet

Three are needed; the placeholders and rules are in a comment block in
`main.tex` above the Walkthrough section.

- **`\Description{}` is required on every figure** (SIGCHI accessibility guide).
  It is not the caption — it carries what a sighted reader gets from the image
  and the caption does not say. It does not render in the PDF; TAPS puts it in
  the HTML5 version.
- **Size figures at their final 2-column size.** A column-wide figure should
  appear at half page width in this 1-column submission, leaving white space
  beside it. Do not scale images; export at the exact size.
- **Do not encode meaning in colour alone** — add shape or pattern.
- Tables must be real tables, not images. Ours are.

## Citations

ACM Reference Format via `\bibliographystyle{ACM-Reference-Format}` — already
set. All 9 entries resolve with no undefined citations.

## What still needs you

Search `main.tex` for `TODO(Joseph)` and `PENDING`.

- **Results, Discussion, Conclusion** — scaffolded against the analysis plan,
  empty. Drop the session logs anywhere in the repo.
- **Ethics statement** — needs the UTokyo GSIST approval number, who was listed
  as main investigator, recruitment channel, and compensation.
- **Demographics as counts** — currently prose ("a few teenagers, a majority in
  their twenties"). Reviewers expect per-band numbers and a mean age.
- **ORCIDs** for `authors.tex` before camera-ready; TAPS flags their absence.
- **CCS concepts** — regenerate the official block at <https://dl.acm.org/ccs>.
  The current one is a reasonable guess, not generated.

## Building locally

```bash
cd paper && latexmk -pdf main.tex
```

TinyTeX on this machine needed `acmart` plus `oberdiek`, `everyshi`, `upquote`
and friends; they are installed. The package repository is pinned to the
TeX Live 2024 archive because the local install is 2024 and cross-release
updates are refused.
