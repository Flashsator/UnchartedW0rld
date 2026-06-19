// Subject → emoji lookup for the explainer-card fallback (FactCard). The emoji
// is decorative: it depicts a subject the narration ALREADY names, so it never
// adds data (invariant #1). Coverage is deliberately broad across the three
// series (animals / insects / plants) so a carded slot can usually show a
// recognizable subject node instead of plain text. Only accurate emoji are
// listed — where the standard set has no faithful glyph (e.g. wasp, moth) the
// word is intentionally absent so the card degrades to text rather than show a
// wrong creature on a science channel.
export const ICON_DICT: Record<string, string> = {
  // --- ocean / aquatic animals ---
  crab: '🦀', octopus: '🐙', shark: '🦈', whale: '🐋', dolphin: '🐬',
  shrimp: '🦐', squid: '🦑', lobster: '🦞', jellyfish: '🪼',
  fish: '🐟', seal: '🦭', otter: '🦦', penguin: '🐧',

  // --- land mammals ---
  wolf: '🐺', fox: '🦊', bear: '🐻', tiger: '🐅', lion: '🦁',
  elephant: '🐘', monkey: '🐒', gorilla: '🦍', deer: '🦌',
  cat: '🐈', kitten: '🐈', dog: '🐕', puppy: '🐕',
  mouse: '🐁', rat: '🐀', rabbit: '🐇', hare: '🐇',
  horse: '🐎', cow: '🐄', pig: '🐖', sheep: '🐑', goat: '🐐',
  camel: '🐪', giraffe: '🦒', zebra: '🦓', rhino: '🦏', rhinoceros: '🦏',
  hippo: '🦛', koala: '🐨', panda: '🐼', raccoon: '🦝', badger: '🦡',
  beaver: '🦫', hedgehog: '🦔', sloth: '🦥', kangaroo: '🦘', bat: '🦇',

  // --- birds ---
  eagle: '🦅', hawk: '🦅', falcon: '🦅', vulture: '🦅',
  owl: '🦉', parrot: '🦜', flamingo: '🦩', peacock: '🦚', swan: '🦢',
  duck: '🦆', bird: '🐦', sparrow: '🐦', crow: '🐦', raven: '🐦',
  dove: '🕊️', pigeon: '🕊️', chick: '🐤', chicken: '🐓', rooster: '🐓',

  // --- reptiles / amphibians ---
  frog: '🐸', lizard: '🦎', gecko: '🦎', turtle: '🐢', tortoise: '🐢',
  snake: '🐍', crocodile: '🐊', alligator: '🐊', dinosaur: '🦖',

  // --- insects / invertebrates ---
  spider: '🕷️', web: '🕸️', cobweb: '🕸️',
  ant: '🐜', bee: '🐝', honeybee: '🐝', honey: '🍯',
  butterfly: '🦋', beetle: '🪲', scorpion: '🦂', mosquito: '🦟', flea: '🦟',
  caterpillar: '🐛', bug: '🐛', grub: '🐛', worm: '🪱',
  fly: '🪰', housefly: '🪰', snail: '🐌', slug: '🐌',
  grasshopper: '🦗', cricket: '🦗', locust: '🦗',
  cockroach: '🪳', roach: '🪳', ladybug: '🐞', ladybird: '🐞', feather: '🪶',

  // --- plants ---
  leaf: '🍃', foliage: '🍃',
  flower: '🌸', blossom: '🌸', bloom: '🌸', petal: '🌸',
  tree: '🌳', forest: '🌳',
  seed: '🌱', seedling: '🌱', sprout: '🌱', sapling: '🌱', shoot: '🌱', grass: '🌱',
  root: '🌿', stem: '🌿', herb: '🌿', vine: '🌿', fern: '🌿', moss: '🌿',
  cactus: '🌵', succulent: '🌵', palm: '🌴',
  sunflower: '🌻', tulip: '🌷', rose: '🌹',
  corn: '🌽', maize: '🌽', wheat: '🌾', grain: '🌾', bamboo: '🎋',
  pollen: '🌼', nectar: '🌼', acorn: '🌰', nut: '🌰',
  fruit: '🍎', berry: '🫐', mushroom: '🍄', fungus: '🍄',

  // --- science / nature / body ---
  brain: '🧠', dna: '🧬', bone: '🦴', tooth: '🦷', skull: '💀',
  eye: '👁️', heart: '❤️', blood: '🩸', egg: '🥚', nest: '🪺',
  microbe: '🦠', virus: '🦠', bacteria: '🦠', germ: '🦠', cell: '🦠',
  microscope: '🔬', telescope: '🔭',
  volcano: '🌋', planet: '🪐', galaxy: '🌌', nebula: '🌌',
  meteor: '☄️', comet: '☄️', asteroid: '🪨', rocket: '🚀', satellite: '🛰️',
  diamond: '💎', crystal: '💎', vent: '💨', wind: '💨',
  water: '💧', droplet: '💧', drop: '💧', rain: '🌧️',
  fire: '🔥', flame: '🔥', ice: '🧊', snow: '❄️', snowflake: '❄️', frost: '❄️',
  sun: '☀️', sunlight: '☀️', moon: '🌙', star: '⭐',
  earth: '🌍', wave: '🌊', ocean: '🌊', sea: '🌊',
  mountain: '⛰️', cloud: '☁️', storm: '🌩️', lightning: '⚡', tornado: '🌪️',
};

// Collect up to `max` DISTINCT subject emoji from a card's text, in the order
// the matching words first appear. Drives the FactCard layout choice
// (0 → text-forward, 1 → focal node, 2 → relation diagram) and is pure so it can
// be unit-tested without Remotion. Light "-s" plural folding (len>3) so
// "flowers"/"wasps"/"beetles" match. Decorative only — see ICON_DICT note.
export function collectCardIcons(text: string, max = 2): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z]+/)) {
    if (!raw) continue;
    const word = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    const icon = ICON_DICT[word];
    if (icon && !seen.has(icon)) {
      seen.add(icon);
      found.push(icon);
      if (found.length >= max) break;
    }
  }
  return found;
}
