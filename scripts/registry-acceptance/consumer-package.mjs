// Construct only the disposable acceptance manifest. The deployed package is unchanged.
import assert from 'node:assert/strict';

export function consumerPackage(source, pins) {
  const pkg = structuredClone(source);
  pkg.name = 'agent-tasks-npm-registry-acceptance';
  pkg.version = '0.0.0';
  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};
  assert.equal(new Set(pins.map(pin => pin.name)).size, pins.length, 'Duplicate release package');
  for (const { name, version } of pins) {
    if (Object.hasOwn(pkg.dependencies, name)) pkg.dependencies[name] = version;
    if (Object.hasOwn(pkg.devDependencies, name) || !Object.hasOwn(pkg.dependencies, name)) {
      pkg.devDependencies[name] = version;
    }
  }
  return pkg;
}
