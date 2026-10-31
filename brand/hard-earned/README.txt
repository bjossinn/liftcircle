HARD EARNED BRAND KIT
Version 1.0 | 31 October 2026

Your work, made visible.

START HERE
1. Open Hard_Earned_Brand_Guide.pdf for the complete visual and verbal identity.
2. Extract this entire kit beside the existing app project, or provide its files to Claude Code.
3. Paste Claude_Code_Hard_Earned_Rebrand.txt into Claude Code and point it to the kit directory.
4. Review the implemented app and the requested BRAND_AUDIT.md and VERIFICATION_REPORT.md before release.

The prompt requires a complete LiftCircle to Hard Earned rename across current product surfaces, metadata, templates, locales and assets. It also requires an exact audit of necessary historical or compatibility references. It preserves existing data and integrations, and prepares rather than executes production-only changes.

CONTENTS
Hard_Earned_Brand_Guide.pdf           Visual guide, 16 pages
Hard_Earned_Brand_Guide.docx          Editable guide
Hard_Earned_Brand_Guide.txt           Complete plain-text guide for coding tools
Claude_Code_Hard_Earned_Rebrand.txt   Full implementation prompt
hard-earned-tokens.css               Complete semantic tokens and scoped examples
contrast-matrix.json                 Computed solid-colour contrast report
compute-contrast.py                 Python 3 report generator, standard library only
Kit_Verification.txt                 Scope and verification record
assets/asset-manifest.json           Asset purposes, dimensions, profiles and checks
assets/*.png                        Eight exact-size raster exports
assets/source/                       Approved full-bleed source raster
implementation/export-icons.cjs     Mechanical exporter, requires Node and Sharp
reference/ui-colour-example.png      Illustrative dark/light UI, example data only

IDENTITY
Public name: Hard Earned
Wordmark: HARD EARNED
Primary motto: Your work, made visible.
Supporting lines: Every set adds up. / Built by showing up.
Charcoal: #17191B
Chalk: #F3EFE7
Vivid ember: #FF694F

Use the original four-plate dumbbell that reads subtly as an H. The corrected icon's background reaches all four edges. The dumbbell retains internal space. Do not add a presentation canvas, exterior transparency, pre-rounded corners, a caption or full name to launcher files. The orange corner is nonessential and may be clipped by masks.

The 1024px PNG is the default opaque master. The Play Store file is 512px, opaque RGBA, sRGB. PWA any and maskable roles are separately named. Native Android adaptive layers and Apple Icon Composer appearance variants are not supplied as finished assets; the application build must create the variants its actual targets require.

IMPLEMENTATION
The CSS is a reference layer with semantic variables and scoped sample classes, not a drop-in rewrite of every application's components. Adapt it to the actual styling framework. Preserve saved theme preferences. Use charcoal labels on vivid ember buttons; warm-white labels on ember do not meet the specified text contrast target. Light-theme accent text uses #A93623.

The complete palette includes functional borders, focus, hover/pressed/disabled states, semantic status colours and chart roles. Font binaries are not included. Recommended fonts are Inter for UI and optional Barlow Semi Condensed for display; retain their respective licences if installed.

REPRODUCING CHECKS
From this kit directory:
  python3 compute-contrast.py

This regenerates contrast-matrix.json beside the script. It checks selected solid-colour roles, not the whole app's accessibility.

With a compatible local Node installation and Sharp package available:
  node implementation/export-icons.cjs

This mechanically regenerates icon exports from assets/source/hard-earned-approved-master.png. It does not redraw or creatively edit the approved mark. Existing prepared assets are already provided; regeneration is optional.

SCOPE
This kit supplies the brand specification, copy, assets and implementation prompt. The existing application's source code has not been changed or deployed by creating this kit. The UI illustration is a static design reference with example values, not evidence of an implemented screen. Feature-dependent copy must be checked against the actual release before publication.
