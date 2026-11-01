// WCAG contrast for every text/background pair the site uses (solid sRGB, same method as the brand kit).
const L = (hex) => {
  const c = hex.match(/\w\w/g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const pairs = [
  ['Chalk text on charcoal', '#F3EFE7', '#17191B', 4.5],
  ['Chalk text on surface', '#F3EFE7', '#202326', 4.5],
  ['Supporting text on charcoal', '#B7BABB', '#17191B', 4.5],
  ['Supporting text on surface', '#B7BABB', '#202326', 4.5],
  ['Muted text on charcoal', '#939A9D', '#17191B', 4.5],
  ['Muted text on surface', '#939A9D', '#202326', 4.5],
  ['Ember display text on charcoal (h1, counts)', '#FF694F', '#17191B', 3],
  ['Ember display text on surface (275, 4 days)', '#FF694F', '#202326', 3],
  ['Ember ink on charcoal (liked chip mark)', '#FF806B', '#17191B', 4.5],
  ['Charcoal on ember (buttons, ticker, stickers, CTA band)', '#17191B', '#FF694F', 4.5],
  ['Charcoal on hover ember', '#17191B', '#FF806B', 4.5],
  ['Chalk on charcoal button (on ember band)', '#F3EFE7', '#17191B', 4.5],
  ['Charcoal on chalk (privacy)', '#17191B', '#F3EFE7', 4.5],
  ['Dark ember ink #A93623 on chalk (privacy headings)', '#A93623', '#F3EFE7', 4.5],
  ['Body #3A4246 on chalk', '#3A4246', '#F3EFE7', 4.5],
  ['Supporting #50595E on chalk', '#50595E', '#F3EFE7', 4.5],
  ['Warm-up W #E9C16C on charcoal', '#E9C16C', '#17191B', 4.5],
  ['Focus ring #AEE9DD vs charcoal', '#AEE9DD', '#17191B', 3],
  ['Focus ring charcoal vs ember (on-ember areas)', '#17191B', '#FF694F', 3],
  ['Focus ring #086966 vs chalk', '#086966', '#F3EFE7', 3],
  ['Control border #7E888D vs surface', '#7E888D', '#202326', 3],
  ['Control border #6C767C vs chalk', '#6C767C', '#F3EFE7', 3],
];
let bad = 0;
for (const [name, fg, bg, min] of pairs) {
  const r = ratio(fg, bg);
  if (r < min) bad++;
  console.log(`${r >= min ? '✓' : '✗'} ${r.toFixed(2).padStart(5)}:1  (needs ${min}:1)  ${name}`);
}
process.exit(bad ? 1 : 0);
