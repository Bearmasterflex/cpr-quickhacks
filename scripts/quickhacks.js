export const QUICKHACKS = Object.freeze({
  impairMovement: { tier: 1, dv: 6, name: "Impair Movement", description: "MOVE -1 durante 60 segundos (20 rondas).", duration: 20, effect: "move", value: -1 },
  sonicShock: { tier: 1, dv: 6, name: "Sonic Shock", description: "Aplica Damaged Ear durante 60 segundos (20 rondas).", duration: 20, effect: "damagedEar" },
  overheat: { tier: 2, dv: 8, name: "Overheat", description: "Quemadura media: 4 de daño al inicio de cada turno.", effect: "burn", damage: 4 },
  shortCircuit: { tier: 2, dv: 8, name: "Short Circuit", description: "El GM desactiva 3 piezas de cyberware no fundacionales durante 60 segundos.", duration: 20, effect: "cyberware", count: 3, chooser: "gm" },
  cyberwareMalfunction: { tier: 3, dv: 10, name: "Cyberware Malfunction", description: "El atacante desactiva 1 pieza de cyberware durante 60 segundos.", duration: 20, effect: "cyberware", count: 1, chooser: "attacker" },
  lure: { tier: 3, dv: 10, name: "Lure", description: "El atacante controla el siguiente movimiento del objetivo.", duration: 1, effect: "controlMove" },
  slow: { tier: 3, dv: 10, name: "Slow", description: "MOVE -1d6 durante 60 segundos (20 rondas).", duration: 20, effect: "moveRoll" },
  synapseBurnout: { tier: 3, dv: 10, name: "Synapse Burnout", description: "3d6 de daño; ignora y no ablaciona armadura.", effect: "directDamage", formula: "3d6" },
  puppet: { tier: 4, dv: 12, name: "Puppet", description: "El atacante controla el siguiente turno del objetivo.", duration: 1, effect: "controlTurn" },
  shardEjection: { tier: 4, dv: 12, name: "Shard Ejection", description: "Expulsa forzadamente un chipware instalado.", effect: "ejectChipware" },
  systemReset: { tier: 4, dv: 12, name: "System Reset", description: "Inconsciente y prone durante 60 segundos o hasta recibir daño.", duration: 20, effect: "unconscious" },
  testQuickhack: { tier: 1, dv: 10, name: "Test Quickhack", description: "Test Description", duration: 10, effect: "Test" }
});

export const TIER_NAMES = Object.freeze(["", "Simple", "Standard", "Difficult", "Advanced"]);

export function isValidQuickhackTarget(actor) {
  return ["character", "mook"].includes(actor?.type);
}

export function buildQuickhackGroups(interfaceRank, ready = true) {
  return [1, 2, 3, 4].map((tier) => {
    const quickhacks = Object.entries(QUICKHACKS)
      .filter(([, quickhack]) => quickhack.tier === tier)
      .map(([id, quickhack]) => ({
        id,
        name: quickhack.name,
        description: quickhack.description,
        dv: quickhack.dv,
        disabled: !ready || !canUseQuickhack(interfaceRank, quickhack)
      }));
    return {
      tier,
      name: TIER_NAMES[tier],
      dv: quickhacks[0]?.dv ?? null,
      label: `${TIER_NAMES[tier]} · Interface ${tier}`,
      quickhacks
    };
  });
}

export function canUseQuickhack(interfaceRank, quickhack) {
  return Number.isFinite(Number(interfaceRank)) && Number(interfaceRank) >= quickhack.tier;
}

export function clearTargetSelection(user) {
  if (!user) return;
  if (typeof user.updateTokenTargets === "function") {
    user.updateTokenTargets([]);
    return;
  }
  for (const target of Array.from(user.targets ?? [])) {
    target.setTarget?.(false, { user, releaseOthers: false });
  }
}

export function succeeds(total, dv) {
  return Number(total) > Number(dv);
}

export function eligibleCyberware(items) {
  return items.filter((item) => item?.type === "cyberware" && item.system?.isInstalled && !item.system?.isFoundational);
}

export function countSelfIce(items) {
  return Math.min(3, items.filter((item) => {
    if (!item?.system?.isInstalled) return false;
    const normalizedName = String(item.name ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    return normalizedName === "selfice" || normalizedName === "autoice";
  }).length);
}

export function getBreachDv(selfIceCount) {
  const count = Number(selfIceCount);
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count === 1) return 6;
  if (count === 2) return 8;
  return 10;
}

function normalizeBreachCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function getBreachProgress(progress, targetUuid, selfIceCount) {
  const required = normalizeBreachCount(selfIceCount);
  if (!progress || progress.targetUuid !== targetUuid || required === 0) return 0;
  const successes = Number(progress.successes);
  if (!Number.isFinite(successes) || successes <= 0) return 0;
  return Math.min(required, Math.floor(successes));
}

export function advanceBreachProgress(progress, targetUuid, selfIceCount) {
  const required = normalizeBreachCount(selfIceCount);
  return {
    targetUuid,
    successes: Math.min(required, getBreachProgress(progress, targetUuid, required) + 1),
    required
  };
}

export function isBreachComplete(progress, targetUuid, selfIceCount, legacyTargetUuid = null) {
  const required = normalizeBreachCount(selfIceCount);
  if (required === 0) return true;
  if (getBreachProgress(progress, targetUuid, required) >= required) return true;
  return required === 1 && legacyTargetUuid === targetUuid;
}

export function getInterfaceRollProgramContext(name) {
  return {
    name,
    system: {
      class: "quickhack",
      damage: {
        standard: "",
        blackIce: ""
      }
    }
  };
}

export function isMissingActiveEffectError(error) {
  const message = String(error?.message ?? error ?? "");
  return /ActiveEffect\s+["'][^"']+["']\s+does not exist/i.test(message);
}

export function expirationData(rounds, combat, worldTime) {
  const data = { seconds: rounds * 3, startTime: worldTime, expiresAt: worldTime + rounds * 3 };
  if (combat?.started && Number.isFinite(combat.round)) {
    data.rounds = rounds;
    data.startRound = combat.round;
    data.expiresRound = combat.round + rounds;
  }
  return data;
}
