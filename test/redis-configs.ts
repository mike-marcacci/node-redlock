import yaml from "js-yaml";
import { readFileSync } from "fs";
import { join } from "path";

interface Compose {
  services: Record<RedisName, { ports: string[] }>;
}

export type RedisName = string;
export type RedisUri = string;

function loadMappingFromCompose(path: string) {
  const compose = yaml.load(
    readFileSync(path, { encoding: "utf-8" })
  ) as Compose;

  const mapping: Record<RedisName, RedisUri> = {};
  for (const [name, conf] of Object.entries(compose.services)) {
    if (!conf.ports) continue;
    expect(conf.ports).toHaveLength(1);
    const portInfo = conf.ports[0];
    expect(portInfo).toContain(":");
    const [port] = portInfo.split(":");
    mapping[name] = { host: "localhost", port };
  }

  return mapping;
}

const mapping = loadMappingFromCompose(
  join(__dirname, "..", "docker-compose.yml")
);

export const redises = mapping;
