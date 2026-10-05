// Renders the README's terminal screenshots: node docs/gen-cards.mjs
// (needs rsvg-convert). Same look as the projects.sivori.xyz cards.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MUTED = '#7c766a', OUTC = '#d9d3c4', CREAM = '#ece6d6', GREEN = '#7fae6f', AMBER = '#d9a441', BLUE = '#6f9fd0', RED = '#e06c5b';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const seg = (t, c) => ({ t, c });
const P = (cmd) => [seg('~/app ', MUTED), seg('❯ ', GREEN), seg(cmd, CREAM)];

function card(title, lines) {
  const h = 74 + 60 + lines.length * 46 + 30;
  const body = lines.map((l, i) => `<text x="56" y="${150 + i * 46}" xml:space="preserve">${l.map((s) => `<tspan fill="${s.c}">${esc(s.t)}</tspan>`).join('')}</text>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${h}" viewBox="0 0 1200 ${h}">
<rect width="1200" height="${h}" rx="18" fill="#1b1a17"/>
<path d="M0 18 a18 18 0 0 1 18 -18 h1164 a18 18 0 0 1 18 18 v56 h-1200 z" fill="#26241d"/>
<circle cx="46" cy="37" r="9" fill="#e06c5b"/><circle cx="80" cy="37" r="9" fill="#d9a441"/><circle cx="114" cy="37" r="9" fill="#79a96a"/>
<text x="600" y="46" text-anchor="middle" font-family="Menlo, monospace" font-size="24" fill="#8f897b">${esc(title)}</text>
<g font-family="Menlo, monospace" font-size="27">${body}</g></svg>`;
}

const cards = {
  push: card('claude — tidepool', [
    P('git push'),
    [seg('⛵ This push to ', MUTED), seg('master', CREAM), seg(' starts Xcode Cloud:', MUTED)],
    [seg('   Tidepool › Release ', CREAM), seg('→ TestFlight + App Store', BLUE)],
    [seg('   d76a6fb..9f239a9  master -> master', MUTED)],
    [],
    [seg('  … 4 minutes later', MUTED)],
    [seg('● ', AMBER), seg('seaworthy', AMBER), seg(' · no build started for ', OUTC), seg('9f239a9', CREAM)],
    [seg('  GitHub\'s webhook was probably missed.', OUTC)],
    [seg('  Start "Release" on master now? ', OUTC), seg('(asks first)', MUTED)],
  ]),
  check: card('claude — /ship-check', [
    P('/ship-check Tidepool'),
    [seg('● ', AMBER), seg('check_release', AMBER), seg(' · Tidepool 2.4 · build 87 ', MUTED), seg('VALID', GREEN)],
    [],
    [seg('  ✗ ', RED), seg('Copyright is empty ', CREAM), seg('(submission 409s without it)', MUTED)],
    [seg('  ✗ ', RED), seg('en-US: missing description, keywords', CREAM)],
    [seg('  ✗ ', RED), seg('en-US: no screenshots', CREAM)],
    [seg('  ✗ ', RED), seg('App Review contact is incomplete', CREAM)],
    [seg('  ! ', AMBER), seg('Release is automatic: live the moment it\'s approved', OUTC)],
    [],
    [seg('  I can set the copyright and draft What\'s New', OUTC)],
    [seg('  from your commits. Want me to?', OUTC)],
  ]),
};

const dir = import.meta.dirname;
for (const [name, svg] of Object.entries(cards)) {
  const src = path.join(dir, `.${name}.svg`);
  fs.writeFileSync(src, svg);
  execFileSync('rsvg-convert', ['-w', '1200', src, '-o', path.join(dir, `${name}.png`)]);
  fs.rmSync(src);
  console.log('✓', name);
}
