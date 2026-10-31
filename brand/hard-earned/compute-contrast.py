import json
from pathlib import Path

OUT = Path(__file__).parent
PALETTES = {
    'dark': {
        'canvas': '#17191B', 'surface': '#202326', 'raised': '#2A2E31',
        'field': '#17191B', 'text': '#F3EFE7', 'text_secondary': '#B7BABB',
        'text_muted': '#939A9D', 'border_subtle': '#3D4448',
        'border_control': '#7E888D', 'accent': '#FF694F',
        'accent_hover': '#FF806B', 'accent_pressed': '#E9563D',
        'on_accent': '#17191B', 'accent_ink': '#FF806B',
        'selected_surface': '#392B29', 'disabled_surface': '#303438',
        'disabled_text': '#9DA4A8', 'focus': '#AEE9DD',
        'success': '#7FD4AB', 'error': '#FF9C91', 'warning': '#E9C16C',
        'danger_fill': '#FF9C91', 'danger_hover': '#FFB5AC',
        'danger_pressed': '#EB8175', 'on_danger': '#17191B',
        'info': '#9CCCF5', 'chart_1': '#FF694F', 'chart_2': '#AEE9DD',
        'chart_3': '#89BFFF', 'chart_4': '#C5A7F2', 'chart_5': '#E9C16C',
    },
    'light': {
        'canvas': '#F3EFE7', 'surface': '#FFFFFF', 'raised': '#E6E2DB',
        'field': '#FFFFFF', 'text': '#17191B', 'text_secondary': '#50595E',
        'text_muted': '#59636A', 'border_subtle': '#D1CCC4',
        'border_control': '#6C767C', 'accent': '#FF694F',
        'accent_hover': '#FF806B', 'accent_pressed': '#E9563D',
        'on_accent': '#17191B', 'accent_ink': '#A93623',
        'selected_surface': '#F8DBD4', 'disabled_surface': '#E1DDD6',
        'disabled_text': '#555E64', 'focus': '#086966',
        'success': '#1E704F', 'error': '#B32F2F', 'warning': '#79520A',
        'danger_fill': '#B32F2F', 'danger_hover': '#982727',
        'danger_pressed': '#7E2020', 'on_danger': '#FFFFFF',
        'info': '#185D91', 'chart_1': '#A93623', 'chart_2': '#1D6A63',
        'chart_3': '#245C99', 'chart_4': '#78409A', 'chart_5': '#79520A',
    },
}

def linear(channel):
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

def luminance(colour):
    s = colour.lstrip('#')
    r, g, b = [linear(int(s[i:i+2], 16) / 255) for i in (0, 2, 4)]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def ratio(a, b):
    l1, l2 = sorted((luminance(a), luminance(b)), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)

rows = []
def add(theme, fg, bg, purpose, minimum, status='approved', note=''):
    p = PALETTES[theme]
    value = ratio(p.get(fg, fg), p.get(bg, bg))
    rows.append({
        'theme': theme, 'foreground_token': fg, 'background_token': bg,
        'foreground_hex': p.get(fg, fg), 'background_hex': p.get(bg, bg),
        'purpose': purpose, 'contrast_ratio': value,
        'display_ratio': f'{value:.2f}:1', 'minimum': minimum,
        'passes_unrounded': value >= minimum if minimum else None,
        'usage_status': status, 'note': note,
    })

for theme in PALETTES:
    for fg in ['text', 'text_secondary', 'text_muted', 'accent_ink']:
        for bg in ['canvas', 'surface', 'raised']:
            add(theme, fg, bg, 'Normal body text / text links', 4.5)
    for bg in ['accent', 'accent_hover', 'accent_pressed']:
        add(theme, 'on_accent', bg, 'Primary button label', 4.5)
    for bg in ['danger_fill', 'danger_hover', 'danger_pressed']:
        add(theme, 'on_danger', bg, 'Destructive button label', 4.5)
        for exterior in ['canvas', 'surface', 'raised']:
            add(theme, bg, exterior, 'Destructive button boundary against exterior surface', 3.0)
    add(theme, 'disabled_text', 'disabled_surface', 'Disabled control label (internal legibility target; inactive controls exempt)', 4.5)
    for bg in ['canvas', 'surface', 'raised']:
        add(theme, 'border_control', bg, 'Required input/control boundary', 3.0)
        add(theme, 'text_secondary', bg, 'Required input/control boundary on hover', 3.0)
        add(theme, 'focus', bg, 'Focus outline, separated from control by 3px of this background', 3.0)
        add(theme, 'border_subtle', bg, 'Decorative divider only; never the sole required control boundary', 3.0, 'decorative_only')
        for fg in ['success', 'error', 'warning', 'info']:
            add(theme, fg, bg, 'Semantic label and icon', 4.5)
        for fg in ['chart_1', 'chart_2', 'chart_3', 'chart_4', 'chart_5']:
            add(theme, fg, bg, 'Data line or marker against plot background', 3.0)
    add(theme, 'text', 'selected_surface', 'Selected row label', 4.5)
    add(theme, 'accent_ink', 'selected_surface', 'Selected-state label and icon', 4.5)
    add(theme, 'focus', 'selected_surface', 'Focus outline adjacent to selected-row surface', 3.0)
    for bg in ['canvas', 'surface', 'raised']:
        add(theme, 'accent', bg, 'Raw ember text / meaningful icon', 4.5, 'approved' if theme == 'dark' else 'rejected')
    for fg in ['accent', 'accent_hover', 'accent_pressed']:
        for bg in ['canvas', 'surface', 'raised']:
            add(theme, fg, bg, 'Primary button fill against exterior surface', 3.0, 'approved' if theme == 'dark' else 'boundary_required', 'Light theme uses an approved 2px charcoal outline; ember fill alone is not the control boundary.')

for fill in ['accent', 'accent_hover', 'accent_pressed']:
    add('light', 'text', fill, '2px dark boundary against primary button fill', 3.0)
for bg in ['canvas', 'surface', 'raised']:
    add('light', 'text', bg, '2px primary button boundary against exterior surface', 3.0)
add('dark', '#F3EFE7', 'accent', 'Chalk button label on ember: rejected', 4.5, 'rejected')
add('light', 'accent', 'canvas', 'Ember-only button boundary on chalk: rejected when boundary identifies control', 3.0, 'rejected')

report = {
    'brand': 'Hard Earned', 'date': '2026-10-31',
    'method': 'WCAG 2.x sRGB relative luminance using 0.04045 transfer threshold; contrast=(Llighter+0.05)/(Ldarker+0.05). Opaque solid colours only. Pass/fail uses unrounded double-precision ratios.',
    'thresholds': {'normal_text_AA': 4.5, 'large_text_AA': 3.0, 'required_nontext_UI_AA': 3.0},
    'scope': 'Token-pair contrast verification only; this is not an audit or claim of whole-app WCAG conformance. Decorative and inactive exceptions are labelled; alpha, gradients and imagery require separate evaluation.',
    'palettes': PALETTES, 'pairs': rows,
    'sources': [
        {'name': 'WCAG 2.2 relative luminance definition', 'url': 'https://www.w3.org/TR/WCAG22/#dfn-relative-luminance'},
        {'name': 'WCAG 2.2 contrast ratio definition', 'url': 'https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio'},
        {'name': 'W3C Understanding SC 1.4.3 Contrast (Minimum)', 'url': 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html'},
        {'name': 'W3C Understanding SC 1.4.11 Non-text Contrast', 'url': 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html'},
    ],
    'summary': {
        'pair_count': len(rows),
        'approved_pair_count': sum(r['usage_status'] == 'approved' for r in rows),
        'approved_pair_failures': sum(r['usage_status'] == 'approved' and not r['passes_unrounded'] for r in rows),
        'decorative_only_pair_count': sum(r['usage_status'] == 'decorative_only' for r in rows),
        'boundary_required_pair_count': sum(r['usage_status'] == 'boundary_required' for r in rows),
        'rejected_pair_count': sum(r['usage_status'] == 'rejected' for r in rows),
    },
}
(OUT / 'contrast-matrix.json').write_text(json.dumps(report, indent=2) + '\n')
failures = [r for r in rows if r['usage_status'] == 'approved' and not r['passes_unrounded']]
print(json.dumps({'pairs': len(rows), 'approved_failures': failures, 'key_pairs': [r for r in rows if 'Primary button label' == r['purpose'] or r['usage_status'] == 'rejected']}, indent=2))
