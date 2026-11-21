---
name: ClearBill
description: A document examination desk for auditing fictional medical bills
colors:
  oat-desk: "#f1eee6"
  oat-dim: "#eae4d6"
  paper: "#fffdf7"
  paper-dim: "#f7f3e9"
  ink: "#24241f"
  ink-raise: "#35352e"
  muted-graphite: "#5d5a51"
  rule-tan: "#d8d0c3"
  brick: "#9b3c28"
  brick-light: "#d07a60"
  flag-tint: "#f4e6df"
  forest: "#296050"
  on-ink-soft: "#b7b1a2"
  print-ink: "#000000"
  print-stock: "#ffffff"
typography:
  display:
    fontFamily: "Georgia, 'Times New Roman', serif"
    fontSize: "clamp(2.25rem, 3.2vw + 1rem, 3.25rem)"
    fontWeight: 400
    lineHeight: 1.06
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Georgia, 'Times New Roman', serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "'Avenir Next', Avenir, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'Avenir Next', Avenir, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: "11.5px"
    fontWeight: 700
    letterSpacing: "0.13em"
  data:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.92em"
    fontWeight: 400
  evidence:
    fontSize: "14px"
  control:
    fontSize: "13px"
  note:
    fontSize: "12.5px"
  disclaimer:
    fontSize: "13.5px"
  worksheet-title:
    fontSize: "27px"
  mobile-display:
    fontSize: "clamp(1.9rem, 8.5vw, 2.6rem)"
rounded:
  sm: "3px"
  indicator: "999px"
spacing:
  rail: "235px"
  gap-desk: "36px"
  pad-region: "34px 36px 56px"
  pad-paper: "42px 48px 50px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  button-ghost:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  nav-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink-soft}"
    padding: "20px 2px 18px"
  input-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
---

# Design System: ClearBill

## Overview

**Creative North Star: "The Document Examination Desk"**

ClearBill is a workbench, not a brochure. The screen reads as a desk where a learner has spread out papers: a pale oat desk surface, a sheet of ruled receipt paper under examination, and a margin of numbered findings beside it. Everything on the desk is a document or a rule, so depth comes from paper tone and ink rules rather than cards, shadows or chrome.

The palette is editorial and warm: ink black, ledger tan, a brick red reserved for flags and attention, and a forest green reserved for verified, linked or clean states. Type pairs a Georgia document voice (case titles, finding numbers, totals) with a humanist sans for interface furniture. The only ornaments are the ones a real bill would carry: ruled lines, alternating paper tones, a double-ruled total, a torn lower edge and the drawn receipt mark.

**Key Characteristics:**

- Paper surfaces and ink rules instead of cards; depth is tonal, never decorative.
- One red pen: brick marks flags, the fiction warning and focus, nothing else.
- Numbers are evidence: tabular numerals everywhere a figure can be checked.
- The receipt is the hero object; the rest of the page is furniture that stays quiet.

## Colors

The palette is a small desk set: two paper tones, one ink, one rule color, two working accents with strict jobs.

### Primary

- **Brick** (#9b3c28): the examiner's red pen. Flagged lines, the fiction warning, finding indices, primary hover, focus accents and text selection. Its rarity is the point.
- **Ink** (#24241f): body text, the dark masthead, total rules, primary buttons. The desk's printing ink.

### Secondary

- **Forest** (#296050): links, the clean-bill state, readiness indicators. Anything verified or affirmative.

### Neutral

- **Pale Oat** (#f1eee6): the desk surface under everything.
- **Oat Dim** (#eae4d6): the safety strip, so it separates from both masthead and desk.
- **Paper** (#fffdf7): every document surface (receipt, worksheet, share panel, inputs).
- **Paper Dim** (#f7f3e9): alternating ledger rows, readonly fields, the worksheet summary box.
- **Rule Tan** (#d8d0c3): all hairline rules and borders.
- **Muted Graphite** (#5d5a51): secondary text, labels, meta rows.
- **On-Ink Soft** (#b7b1a2) and **Brick Light** (#d07a60): inactive nav text and the active-view rule on the dark masthead only.
- **Flag Tint** (#f4e6df): the row highlight for a line tied to a finding.
- **Print Ink** (#000000) and **Print Stock** (#ffffff): print-only colors for home and office printers, never the on-screen palette.

### Named Rules

**The One Red Pen Rule.** Brick appears only where the examiner would mark: flags, warnings, the active line under scrutiny, focus. Never as background, brand color or decoration.
**The Two Papers Rule.** Surfaces are Paper or Paper Dim, alternating. No third surface color and no white that is not paper.

## Typography

**Display Font:** Georgia (Times New Roman fallback)
**Body Font:** Avenir Next (Avenir, Segoe UI, Helvetica Neue, Helvetica, Arial)
**Label/Mono Font:** system mono stack, only for procedure codes

**Character:** Georgia carries the documents being examined; the humanist sans carries the furniture around them. Codes get a real mono because they are data.

### Hierarchy

- **Display** (400, clamp 2.25rem to 3.25rem, 1.06, -0.015em): case titles and the Medicare reference heading. Largest 52px.
- **Title** (700, 19-20px, 1.2): document headings: Itemized bill, Audit findings, section heads.
- **Body** (400, 16px, 1.55): findings text, controls, rail notes. Measures stay under about 62ch in prose.
- **Label** (700, 11.5-13px, 0.12-0.16em tracking, uppercase): rail heading, field labels, table heads, finding tags.
- **Data** (400, 0.92em mono, tabular): procedure codes; `font-variant-numeric: tabular-nums` on every money, meta and index figure.

### Named Rules

**The Document Voice Rule.** Georgia is only for content that belongs to the paper under review (titles, indices, computed totals). Interface furniture never sets Georgia.

## Layout

A horizontal dark masthead (brand left, three workbench destinations right) sits above a slim fiction-warning strip. Below, the desk is an asymmetric grid: a 235px case rail on the left separated by a vertical rule, and a work region holding a full-width case header (Georgia title plus a ruled metadata row) over a two-column audit grid of roughly 8:5, receipt wider than findings.

At or below 1080px the rail folds to the top and case buttons become wrapped chips. At 760px the audit grid stacks and a jump button brings the findings into reach before the ledger. At 560px the case rail condenses to three short cells, the ledger stacks into labeled rows (`data-label` pseudo labels) and padding tightens. Printing with `body[data-print="worksheet"]` removes all furniture and leaves the worksheet sheet alone on a Letter page.

## Elevation & Depth

Flat by default. Depth is paper on oat plus one hairline at a time; the worksheet sheet gets the system's only shadow, a low diffuse lift (`0 2px 6px rgba(36,36,31,.07), 0 12px 26px rgba(36,36,31,.05)`) because it is a page resting on the desk. The receipt signals paper by tone, a single border and a torn lower edge drawn with a conic-gradient mask, not by a shadow.

### Named Rules

**The Flat-By-Default Rule.** No shadow anywhere except the worksheet sheet. If a surface needs separation, reach for a rule or a tone step first.

## Shapes

Corners are nearly square: 3px on buttons, inputs, chips and the segmented control; 0-1px on documents and panels. The recurring silhouettes are the torn receipt edge and the double-ruled ledger total. Pills appear only as the finding-count badge.

## Components

### Buttons

- **Shape:** nearly square (3px radius).
- **Primary:** ink fill, paper text, 1px ink border; hover turns the ink brick.
- **Ghost:** paper fill, ink border and text; hover inverts to ink fill.
- **Segmented:** joined buttons sharing an ink border, the pressed segment filled ink.

### Inputs / Fields

- **Style:** paper fill, 1px rule-tan border, 3px radius, small-caps label above.
- **Focus:** ink border plus the ink focus-visible outline; brick caret.
- **Selects:** native-looking but chrome-free; the chevron is drawn with gradients because the CSP forbids data URIs.
- **Readonly:** paper-dim fill, muted text.

### Navigation

- **Masthead:** dark ink bar. Brand is the drawn receipt mark plus a Georgia wordmark. Nav buttons are uppercase small labels, soft oat at rest; the pressed view carries a light brick inset rule. Wraps to a second line under 560px.

### Case rail

- Entries are ledger lines: a tabular Georgia index, a name, a small detail line, separated by hairlines on the rail. Selected lifts to paper with a brick index. On narrow screens they become wrapped chips.

### The receipt

- Paper sheet with a 2px ink rule under its head, small-caps column heads over a single ink rule, hairline row rules, alternating paper-dim rows, right-aligned tabular money, mono codes, a flag-tint highlight for lines under scrutiny, a torn conic-mask bottom edge, and a double-ruled settlement total.

### Findings

- A numbered order of evidence under a 2px ink rule: brick Georgia indices, body text, a small-caps brick tag, muted rule references, hairline separators. The clean state is a forest line between two rules.

## Do's and Don'ts

### Do:

- **Do** set money, meta and index figures with `font-variant-numeric: tabular-nums`.
- **Do** separate surfaces with 1px rule-tan lines, and close totals with a 3px double ink rule.
- **Do** keep brick for flags and focus; keep forest for links and clean or ready states.
- **Do** keep labels in the uppercase tracked label style; headings stay Georgia.

### Don't:

- **Don't** introduce cards, nested panels, gradients or decorative shadows; the desk is flat.
- **Don't** add kickers, eyebrows or taglines; the title stands alone.
- **Don't** use the receipt mark, zigzag edge or double rule on anything that is not a document.
- **Don't** set interface text in Georgia or document figures without tabular numerals.
