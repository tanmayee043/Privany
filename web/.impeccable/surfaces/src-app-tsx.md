---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

Scope: the whole Privany web app (start screen, run progress, report). Mode: Operate.
Audience: everyday web users deciding whether to trust a site; hackathon judges in a 3-minute demo.
Job: enter a site, wait about a minute, read where promises and behavior agree or diverge, expand evidence, adjust priorities, leave with one action.
Constraints: no numeric score; verdicts never by colour alone; every quote shown is verified; unknowns stated plainly.

## Direction contract

THESIS: The report is a Privacy Facts panel, a label everyone already knows how to read: each line a promise and its result, every line opening into its evidence. It refuses the category's summary-card grid with coloured badges.

OWN-WORLD: White label panels on a cool blue-grey ground (#E9EDF3), ink #111 rules at three weights (10px bar, 5px divider, 1px line), Archivo Narrow 700/800 for the label title, Archivo for everything else, tabular numerals throughout. Black top bar. Blue #1D4ED8 marks evidence, links and selection; red #B42318 only for "possible gap", always with words and a rule weight, never colour alone.

STORY: The visitor types a site; the label prints line by line as each check finishes; they read the panel, click a line, see the policy's own sentence beside the default-versus-GPC cookie counts and caveats, set what they care about, and get next steps the policy documents.

FIRST VIEWPORT: Report: black bar with brand, site and run facts; left, a 440px Privacy Facts panel (title, policy date, the six promises with results, cookie totals, footnote); right, the selected promise's evidence pane: plain headline, verified quote with source section, three-column count strip, caveats, then priorities and next steps below.

FORM: The Privacy Facts Label, item 1 of the safer-register list (user-chosen), seed key a58cfbda. Signature move: the label fills in line by line during the run, and the same panel becomes the report's navigation.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
