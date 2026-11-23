const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemver(version) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error('Invalid semantic version');
  const validIdentifiers = (part, prerelease = false) => !part || part.split('.').every((id) => id.length > 0 && /^[0-9A-Za-z-]+$/.test(id) && !(prerelease && /^\d+$/.test(id) && id.length > 1 && id.startsWith('0')));
  if (!validIdentifiers(match[4], true) || !validIdentifiers(match[5])) throw new Error('Invalid semantic version');
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4]?.split('.') ?? [] };
}

export function compareSemver(a, b) {
  const left = parseSemver(a); const right = parseSemver(b);
  for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i]; const y = right.prerelease[i];
    if (x === undefined) return -1; if (y === undefined) return 1; if (x === y) continue;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
