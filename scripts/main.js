import CPRChat from "../../../systems/cyberpunk-red-core/modules/chat/cpr-chat.js";
import { CPRInterfaceRoll } from "../../../systems/cyberpunk-red-core/modules/rolls/cpr-rolls.js";
import CPRMod from "../../../systems/cyberpunk-red-core/modules/rolls/cpr-modifiers.js";
import SystemUtils from "../../../systems/cyberpunk-red-core/modules/utils/cpr-systemUtils.js";
import {
  QUICKHACKS,
  advanceBreachProgress,
  buildQuickhackGroups,
  canUseQuickhack,
  clearTargetSelection,
  countSelfIce,
  eligibleCyberware,
  expirationData,
  getBreachDv,
  getBreachProgress,
  getInterfaceRollProgramContext,
  isBreachComplete,
  isMissingActiveEffectError,
  isValidQuickhackTarget,
  succeeds
} from "./quickhacks.js";

const MODULE_ID = "cpr-quickhacks";
const SYSTEM_ID = "cyberpunk-red-core";
const SOCKET = `module.${MODULE_ID}`;
const FLAG = `flags.${MODULE_ID}`;
const EFFECT_MODE_ADD = 2;
const deletingEffects = new Set();
let expirationQueue = Promise.resolve();

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "requireJackIn", {
    name: "Exigir Jack In",
    hint: "Los quickhacks solo pueden lanzarse contra el objetivo conectado mediante Jack In.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", () => {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error("CPR Quickhacks requiere Cyberpunk RED - CORE.");
    return;
  }
  game.socket.on(SOCKET, receiveSocket);
  game.cprQuickhacks = Object.freeze({
    open: openQuickhackDialog,
    quickhacks: QUICKHACKS,
    getDialogState: () => getQuickhackDialogState(),
    executeAction: executeQuickhackDialogAction,
    jackIn,
    breach,
    jackOut
  });
  Hooks.callAll("cprQuickhacksReady", game.cprQuickhacks);
});

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControls = Array.isArray(controls) ? controls.find((control) => control.name === "token") : controls.tokens;
  if (!tokenControls) return;
  const tool = {
    name: MODULE_ID,
    title: "CPRQH.Open",
    icon: "fas fa-microchip",
    button: true,
    onClick: openQuickhackDialog
  };
  if (Array.isArray(tokenControls.tools)) {
    if (!tokenControls.tools.some((entry) => entry.name === MODULE_ID)) tokenControls.tools.push(tool);
  } else {
    tokenControls.tools ??= {};
    tokenControls.tools[MODULE_ID] = tool;
  }
});

Hooks.on("updateCombat", async (combat) => {
  if (!isActiveGM()) return;
  try {
    await queueExpiration(combat);
    await applyBurnAtTurnStart(combat);
  } catch (error) {
    console.error(`${MODULE_ID} | Error al procesar el cambio de turno.`, error);
  }
});

Hooks.on("updateWorldTime", async (worldTime) => {
  if (!isActiveGM()) return;
  try {
    await queueExpiration(game.combat, worldTime);
  } catch (error) {
    console.error(`${MODULE_ID} | Error al procesar el tiempo del mundo.`, error);
  }
});

Hooks.on("updateActor", async (actor, changes) => {
  if (!isActiveGM()) return;
  const newHp = foundry.utils.getProperty(changes, "system.derivedStats.hp.value");
  if (!Number.isFinite(newHp)) return;
  const reset = actor.effects.find((effect) => effect.getFlag(MODULE_ID, "quickhackId") === "systemReset");
  const initialHp = reset?.getFlag(MODULE_ID, "hpAtApplication");
  if (reset && Number.isFinite(initialHp) && newHp < initialHp) await deleteManagedEffect(reset);
});

async function openQuickhackDialog() {
  const state = getQuickhackDialogState({ notify: true, includeContext: true });
  if (!state.ready) return;
  const { attacker, target, role } = state;
  const groups = state.groups.map((group) => {
    const buttons = group.quickhacks.map((quickhack) => {
      const disabled = quickhack.disabled ? "disabled" : "";
      return `<button type="button" class="cpr-qh-action" data-quickhack="${quickhack.id}" data-tooltip="${escapeHtml(quickhack.description)}" ${disabled}>${escapeHtml(quickhack.name)}<span class="cpr-qh-meta">DV ${quickhack.dv} · ${escapeHtml(quickhack.description)}</span></button>`;
    }).join("");
    return `<h3 class="cpr-qh-tier">${escapeHtml(group.label)}</h3>${buttons}`;
  }).join("");
  const breachDisabled = state.breachDisabled ? "disabled" : "";
  const content = `<section class="cpr-qh-dialog"><div class="cpr-qh-header"><span><b>${escapeHtml(state.attackerName)}</b> → ${escapeHtml(state.targetName)}</span><div class="cpr-qh-connection-actions"><button type="button" data-connection="${state.connectionAction}">${state.connectionLabel}</button><button type="button" data-breach ${breachDisabled}>${state.breachLabel}</button></div></div><div class="cpr-qh-grid">${groups}</div></section>`;
  const dialog = new Dialog({ title: game.i18n.localize("CPRQH.Title"), content, buttons: {}, close: () => {} }, { width: 520 });
  dialog.render(true);
  Hooks.once("renderDialog", (app, html) => {
    if (app !== dialog) return;
    html.find("[data-connection]").on("click", async (event) => {
      if (event.currentTarget.dataset.connection === "jack-in") await jackIn(attacker, target);
      else await jackOut(attacker, target);
      await dialog.close();
    });
    html.find("[data-breach]").on("click", async (event) => {
      if (event.currentTarget.disabled) return;
      await dialog.close();
      await breach(attacker, target, role);
    });
    html.find("[data-quickhack]").on("click", async (event) => {
      if (event.currentTarget.disabled) return ui.notifications.warn(game.i18n.localize("CPRQH.Locked"));
      await dialog.close();
      await executeQuickhack(event.currentTarget.dataset.quickhack, attacker, target, role);
    });
  });
}

function getQuickhackDialogState({
  notify = false,
  includeContext = false,
  targetOverride = null
} = {}) {
  const attacker = canvas.tokens.controlled[0] ?? null;
  const targets = Array.from(game.user.targets);
  const target = targetOverride ?? (targets.length === 1 ? targets[0] : null);
  const role = attacker ? getInterfaceRole(attacker.actor) : null;
  const validTarget = isValidQuickhackTarget(target?.actor);
  let status = "";

  if (!attacker) {
    status = game.i18n.localize("CPRQH.NoToken");
  } else if (!target) {
    status = game.i18n.localize("CPRQH.OneTarget");
  } else if (!validTarget) {
    status = game.i18n.localize("CPRQH.InvalidTarget");
  } else if (!role) {
    status = game.i18n.localize("CPRQH.NoInterface");
  }

  if (notify && status) ui.notifications.warn(status);

  const ready = Boolean(attacker && target && validTarget && role);
  const rank = Number(role?.system.rank) || 0;
  const targetUuid = target?.document.uuid ?? null;
  const connected = ready
    && attacker.actor.getFlag(MODULE_ID, "jackedTarget") === targetUuid;
  const selfIce = ready ? countSelfIce(target.actor.items.contents) : 0;
  const breachDv = getBreachDv(selfIce);
  const storedBreachProgress = ready
    ? attacker.actor.getFlag(MODULE_ID, "breachProgress")
    : null;
  const breachProgress = getBreachProgress(
    storedBreachProgress,
    targetUuid,
    selfIce
  );
  const breached = ready && isBreachComplete(
    storedBreachProgress,
    targetUuid,
    selfIce,
    attacker.actor.getFlag(MODULE_ID, "breachedTarget")
  );
  const connectionAction = connected ? "jack-out" : "jack-in";
  const connectionLabel = connected
    ? game.i18n.localize("CPRQH.JackOut")
    : game.i18n.localize("CPRQH.JackIn");
  const breachLabel = !breachDv
    ? game.i18n.localize("CPRQH.BreachOpen")
    : breached
      ? game.i18n.localize("CPRQH.Breached")
      : game.i18n.format("CPRQH.BreachProgress", {
        current: breachProgress,
        total: selfIce,
        dv: breachDv
      });
  const groups = buildQuickhackGroups(rank, ready);
  const state = {
    ready,
    status,
    attackerName: attacker?.name ?? "",
    targetName: target?.name ?? "",
    rank,
    connected,
    breached,
    breachDv,
    selfIce,
    breachProgress,
    breachRemaining: Math.max(0, selfIce - breachProgress),
    connectionAction,
    connectionLabel,
    connectionDisabled: !attacker || !role,
    breachLabel,
    breachDisabled: !ready || !connected || breached,
    groups
  };

  if (includeContext) {
    state.attacker = attacker;
    state.target = target;
    state.role = role;
  }
  return state;
}

async function executeQuickhackDialogAction(
  action,
  quickhackId = null,
  targetOverride = null
) {
  const state = getQuickhackDialogState({
    notify: true,
    includeContext: true,
    targetOverride
  });
  if (!state.ready) return false;

  const { attacker, target, role } = state;
  switch (action) {
    case "jack-in":
      await jackIn(attacker, target);
      return true;
    case "jack-out":
      await jackOut(attacker, target);
      return true;
    case "breach":
      if (state.breachDisabled) return false;
      await breach(attacker, target, role);
      return true;
    case "quickhack":
      if (!QUICKHACKS[quickhackId]) return false;
      await executeQuickhack(quickhackId, attacker, target, role);
      return true;
    default:
      return false;
  }
}

function getInterfaceRole(actor) {
  return actor.itemTypes.role?.find((role) => role.id === actor.system.roleInfo.activeNetRole)
    ?? actor.itemTypes.role?.find((role) => String(role.system.mainRoleAbility).toLowerCase() === "interface");
}

async function jackIn(attacker, target) {
  if (!attacker?.actor || !target?.actor || !target?.document) return false;
  if (!isValidQuickhackTarget(target.actor)) {
    ui.notifications.warn(game.i18n.localize("CPRQH.InvalidTarget"));
    return false;
  }
  await attacker.actor.unsetFlag(MODULE_ID, "breachedTarget");
  await attacker.actor.unsetFlag(MODULE_ID, "breachProgress");
  await attacker.actor.setFlag(MODULE_ID, "jackedTarget", target.document.uuid);
  await postCard("Jack In", attacker, target, "Conexión establecida. Si el objetivo tiene Self-ICE, debes completar Breach antes de ejecutar quickhacks.", true);
  return true;
}

async function jackOut(attacker, target = null) {
  const actor = attacker?.actor ?? attacker;
  if (!actor) return false;
  const jackedTargetUuid = actor.getFlag(MODULE_ID, "jackedTarget");
  let targetContext = target;
  if (!targetContext && jackedTargetUuid) {
    const targetDocument = await fromUuid(jackedTargetUuid);
    if (targetDocument) {
      targetContext = targetDocument.object ?? {
        actor: targetDocument.actor,
        document: targetDocument,
        name: targetDocument.name
      };
    }
  }
  await actor.unsetFlag(MODULE_ID, "jackedTarget");
  await actor.unsetFlag(MODULE_ID, "breachedTarget");
  await actor.unsetFlag(MODULE_ID, "breachProgress");
  const attackerContext = attacker?.actor
    ? attacker
    : { actor, document: null, name: actor.name };
  if (targetContext) {
    await postCard("Jack Out", attackerContext, targetContext, "Conexión finalizada de forma segura.", true);
  } else {
    const result = game.i18n.localize("CPRQH.Success");
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="cpr-qh-card success"><h3>Jack Out · ${escapeHtml(result)}</h3><p>${escapeHtml(actor.name)}</p><p>Conexión finalizada de forma segura.</p></div>`
    });
  }
  clearTargetSelection(game.user);
  return true;
}

async function breach(attacker, target, role = getInterfaceRole(attacker?.actor)) {
  if (!attacker?.actor || !target?.actor || !target?.document || !role) return false;
  if (attacker.actor.getFlag(MODULE_ID, "jackedTarget") !== target.document.uuid) {
    ui.notifications.warn(game.i18n.localize("CPRQH.NotJacked"));
    return false;
  }

  const selfIce = countSelfIce(target.actor.items.contents);
  const dv = getBreachDv(selfIce);
  const targetUuid = target.document.uuid;
  if (!dv) {
    await attacker.actor.unsetFlag(MODULE_ID, "breachProgress");
    await attacker.actor.setFlag(MODULE_ID, "breachedTarget", target.document.uuid);
    await postCard("Breach", attacker, target, game.i18n.localize("CPRQH.NoPasswall"), true);
    return true;
  }

  const storedProgress = attacker.actor.getFlag(MODULE_ID, "breachProgress");
  const legacyTargetUuid = attacker.actor.getFlag(MODULE_ID, "breachedTarget");
  const currentProgress = getBreachProgress(storedProgress, targetUuid, selfIce);
  if (isBreachComplete(storedProgress, targetUuid, selfIce, legacyTargetUuid)) {
    return true;
  }

  const cprRoll = await performInterfaceRoll("Breach", attacker, target, role, "backdoor");
  if (!cprRoll) return false;
  const success = succeeds(cprRoll.resultTotal, dv);
  if (!success) {
    await postCard("Breach", attacker, target, game.i18n.format("CPRQH.BreachFailed", {
      result: cprRoll.resultTotal,
      dv,
      current: currentProgress,
      total: selfIce
    }), false);
    return false;
  }

  const nextProgress = advanceBreachProgress(storedProgress, targetUuid, selfIce);
  await attacker.actor.setFlag(MODULE_ID, "breachProgress", nextProgress);
  const complete = isBreachComplete(nextProgress, targetUuid, selfIce);
  const remaining = Math.max(0, selfIce - nextProgress.successes);
  if (complete) {
    await attacker.actor.setFlag(MODULE_ID, "breachedTarget", targetUuid);
  } else {
    await attacker.actor.unsetFlag(MODULE_ID, "breachedTarget");
  }
  await postCard("Breach", attacker, target, game.i18n.format(
    complete ? "CPRQH.BreachCompletedRoll" : "CPRQH.BreachSucceeded",
    {
      result: cprRoll.resultTotal,
      dv,
      current: nextProgress.successes,
      total: selfIce,
      remaining
    }
  ), true);
  return success;
}

async function executeQuickhack(id, attacker, target, role) {
  const quickhack = QUICKHACKS[id];
  if (!quickhack) return;
  const rank = Number(role.system.rank) || 0;
  if (!canUseQuickhack(rank, quickhack)) return ui.notifications.warn(game.i18n.localize("CPRQH.Locked"));
  if (game.settings.get(MODULE_ID, "requireJackIn") && attacker.actor.getFlag(MODULE_ID, "jackedTarget") !== target.document.uuid) {
    return ui.notifications.warn(game.i18n.localize("CPRQH.NotJacked"));
  }
  const selfIce = countSelfIce(target.actor.items.contents);
  const breachDv = getBreachDv(selfIce);
  const breachComplete = isBreachComplete(
    attacker.actor.getFlag(MODULE_ID, "breachProgress"),
    target.document.uuid,
    selfIce,
    attacker.actor.getFlag(MODULE_ID, "breachedTarget")
  );
  if (breachDv && !breachComplete) {
    return ui.notifications.warn(game.i18n.localize("CPRQH.NotBreached"));
  }
  if (!game.user.isGM && !game.users.some((user) => user.active && user.isGM)) {
    return ui.notifications.error(game.i18n.localize("CPRQH.NoActiveGM"));
  }
  const choices = await prepareAttackerChoices(quickhack, target.actor);
  if (choices === null) return;
  const cprRoll = await performInterfaceRoll(quickhack.name, attacker, target, role, "attack");
  if (!cprRoll) return;
  const success = succeeds(cprRoll.resultTotal, quickhack.dv);
  await postCard(quickhack.name, attacker, target, `${cprRoll.resultTotal} contra DV ${quickhack.dv}.`, success);
  if (!success) return;
  const payload = { type: "apply", id, sourceUuid: attacker.actor.uuid, targetUuid: target.actor.uuid, requesterId: game.user.id, choices };
  if (game.user.isGM) await applyQuickhack(payload);
  else game.socket.emit(SOCKET, payload);
}

async function performInterfaceRoll(title, attacker, target, role, ability) {
  const rank = Number(role.system.rank) || 0;
  const cprRoll = new CPRInterfaceRoll("action", role.system.mainRoleAbility || "Interface", rank);
  cprRoll.rollTitle = title;
  cprRoll.ability = ability;
  cprRoll.rollCardExtraArgs.program = getInterfaceRollProgramContext(title);
  cprRoll.rollCardExtraArgs.cyberdeck = { id: "" };
  addNativeInterfaceModifiers(cprRoll, attacker.actor, role.system.mainRoleAbility || "Interface", ability);
  const keepRolling = await cprRoll.handleRollDialog({ type: "click", ctrlKey: false, metaKey: false }, attacker.actor, null);
  if (!keepRolling) return null;
  await cprRoll.roll();
  cprRoll.entityData = { actor: attacker.actor.id, token: attacker.document.id, tokens: [target.document.id] };
  await CPRChat.RenderRollCard(cprRoll);
  return cprRoll;
}

function addNativeInterfaceModifiers(cprRoll, actor, roleName, ability) {
  const allMods = CPRMod.getAllModifiers(Array.from(actor.allApplicableEffects()));
  const defaults = allMods.filter((mod) => !mod.isSituational || mod.onByDefault);
  cprRoll.addMod(CPRMod.getRelevantMods(defaults, ability));
  cprRoll.addMod(CPRMod.getRelevantMods(defaults, SystemUtils.slugify(roleName)));
  cprRoll.addMod(CPRMod.getRelevantMods(defaults, ["allActions", "allActionsSpeech", "allActionsHands"]));
  cprRoll.addMod([{ value: actor.getWoundStateMods(), source: game.i18n.localize("CPR.rolls.modifiers.sources.woundStatePenalty") }]);
}

async function prepareAttackerChoices(quickhack, actor) {
  if (quickhack.chooser === "attacker") {
    const selected = await chooseItems(eligibleCyberware(actor.items.contents), quickhack.count, quickhack.name);
    return selected;
  }
  if (quickhack.effect === "ejectChipware") {
    const chipware = actor.itemTypes.cyberware.filter((item) => item.system.isInstalled && String(item.system.type).toLowerCase().includes("chipware"));
    return chooseItems(chipware, 1, quickhack.name);
  }
  return [];
}

async function receiveSocket(payload) {
  if (!isActiveGM() || payload?.type !== "apply") return;
  const quickhack = QUICKHACKS[payload.id];
  const source = await fromUuid(payload.sourceUuid);
  const target = await fromUuid(payload.targetUuid);
  const requester = game.users.get(payload.requesterId);
  if (!quickhack || !source || !target || !requester || !source.testUserPermission(requester, "OWNER")) return;
  const role = getInterfaceRole(source);
  if (!role || !canUseQuickhack(Number(role.system.rank), quickhack)) return;
  await applyQuickhack(payload);
}

async function applyQuickhack(payload) {
  const quickhack = QUICKHACKS[payload.id];
  const source = await fromUuid(payload.sourceUuid);
  const target = await fromUuid(payload.targetUuid);
  if (!quickhack || !source || !target) return;
  switch (quickhack.effect) {
    case "move": return createTimedEffect(target, payload.id, quickhack, [{ key: "system.stats.move.value", mode: EFFECT_MODE_ADD, value: quickhack.value }], source);
    case "moveRoll": {
      const roll = await new Roll("1d6").evaluate();
      await showDice(roll);
      return createTimedEffect(target, payload.id, quickhack, [{ key: "system.stats.move.value", mode: EFFECT_MODE_ADD, value: -roll.total }], source, `MOVE -${roll.total}`);
    }
    case "damagedEar": return applyDamagedEar(target, payload.id, quickhack, source);
    case "burn": return createManagedEffect(target, payload.id, quickhack, source, "Quemadura media: 4 PV al inicio de cada turno.");
    case "cyberware": return disableCyberware(target, payload, quickhack, source);
    case "directDamage": return applyDirectDamage(target, quickhack, source);
    case "ejectChipware": return ejectChipware(target, payload.choices);
    case "controlMove": return createTimedEffect(target, payload.id, quickhack, [], source, `${source.name} controla el siguiente movimiento del objetivo.`);
    case "controlTurn": return createTimedEffect(target, payload.id, quickhack, [], source, `${source.name} controla el siguiente turno del objetivo.`);
    case "unconscious": {
      const effect = await createTimedEffect(target, payload.id, quickhack, [], source, "Inconsciente y prone; termina al recibir daño.", ["unconscious", "prone"]);
      await effect.setFlag(MODULE_ID, "hpAtApplication", target.system.derivedStats.hp.value);
      return effect;
    }
    default: return null;
  }
}

async function createTimedEffect(actor, id, quickhack, changes, source, note = "", statuses = []) {
  const duration = expirationData(quickhack.duration, game.combat, game.time.worldTime);
  return createManagedEffect(actor, id, quickhack, source, note, {
    changes,
    statuses,
    duration: { seconds: duration.seconds, rounds: duration.rounds, startTime: duration.startTime, startRound: duration.startRound },
    expiresAt: duration.expiresAt,
    expiresRound: duration.expiresRound
  });
}

async function createManagedEffect(actor, id, quickhack, source, note = "", options = {}) {
  const previous = actor.effects.filter((effect) => effect.getFlag(MODULE_ID, "quickhackId") === id);
  for (const effect of previous) await deleteManagedEffect(effect);
  const flags = { quickhackId: id, sourceUuid: source.uuid, note, expiresAt: options.expiresAt, expiresRound: options.expiresRound };
  const changes = options.changes ?? [];
  const cprFlags = {
    changes: {
      cats: changes.map((change) => change.key.startsWith("system.stats.") ? "stat" : "custom"),
      situational: changes.map(() => ({ isSituational: false, onByDefault: false }))
    }
  };
  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: quickhack.name,
    img: quickhack.effect === "unconscious" ? "icons/svg/unconscious.svg" : "icons/svg/aura.svg",
    origin: source.uuid,
    disabled: false,
    changes,
    statuses: options.statuses ?? [],
    duration: options.duration ?? {},
    flags: { [MODULE_ID]: flags, [SYSTEM_ID]: cprFlags }
  }]);
  return effect;
}

async function applyDamagedEar(actor, id, quickhack, source) {
  const effect = await createTimedEffect(actor, id, quickhack, [], source, "Damaged Ear durante 60 segundos.");
  const pack = game.packs.get(`${SYSTEM_ID}.core_critical-injuries-head`);
  if (!pack) return effect;
  const docs = await pack.getDocuments();
  const injury = docs.find((doc) => ["damaged ear", "oído dañado", "oido dañado"].includes(doc.name.toLowerCase()));
  if (!injury) return effect;
  const data = injury.toObject();
  delete data._id;
  data.flags ??= {};
  data.flags[MODULE_ID] = { temporaryEffectId: effect.id };
  await actor.createEmbeddedDocuments("Item", [data]);
  return effect;
}

async function disableCyberware(actor, payload, quickhack, source) {
  const available = eligibleCyberware(actor.items.contents);
  let ids = payload.choices ?? [];
  if (quickhack.chooser === "gm") ids = await chooseItems(available, Math.min(quickhack.count, available.length), quickhack.name);
  if (!ids?.length) return ui.notifications.warn("No hay cyberware elegible para desactivar.");
  const selected = available.filter((item) => ids.includes(item.id)).slice(0, quickhack.count);
  const effect = await createTimedEffect(actor, payload.id, quickhack, [], source, `Cyberware desactivado: ${selected.map((item) => item.name).join(", ")}`);
  await effect.setFlag(MODULE_ID, "cyberwareIds", selected.map((item) => item.id));
  for (const item of selected) {
    await item.setFlag(MODULE_ID, "disabledByQuickhack", effect.id);
    await item.setFlag(MODULE_ID, "previousEffectStates", Object.fromEntries(item.effects.map((entry) => [entry.id, entry.disabled])));
    await Promise.all(item.effects.map((entry) => entry.update({ disabled: true })));
  }
  return effect;
}

async function applyDirectDamage(actor, quickhack, source) {
  const roll = await new Roll(quickhack.formula).evaluate();
  await showDice(roll);
  const hp = actor.system.derivedStats.hp.value;
  await actor.update({ "system.derivedStats.hp.value": Math.max(0, hp - roll.total) });
  await ChatMessage.create({ content: `<div class="cpr-qh-card"><h3>${quickhack.name}</h3><p>${escapeHtml(actor.name)} recibe <b>${roll.total}</b> de daño directo. Ignora y no ablaciona armadura.</p></div>`, speaker: ChatMessage.getSpeaker({ actor: source }) });
}

async function ejectChipware(actor, ids = []) {
  const item = actor.itemTypes.cyberware.find((entry) => ids.includes(entry.id) && entry.system.isInstalled && String(entry.system.type).toLowerCase().includes("chipware"));
  if (!item) return ui.notifications.warn("No se seleccionó chipware instalado válido.");
  const foundationalId = item.system.installedIn?.[0];
  await actor.uninstallCyberware(item.id, foundationalId, true);
  await ChatMessage.create({ content: `<div class="cpr-qh-card"><h3>Shard Ejection</h3><p>${escapeHtml(item.name)} ha sido eyectado de ${escapeHtml(actor.name)}.</p></div>` });
}

async function chooseItems(items, count, title) {
  if (!items.length) {
    ui.notifications.warn("No hay elementos elegibles.");
    return null;
  }
  return new Promise((resolve) => {
    const fields = items.map((item) => `<label><input type="checkbox" name="choice" value="${item.id}"> ${escapeHtml(item.name)}</label>`).join("<br>");
    new Dialog({
      title,
      content: `<form><p>Selecciona ${count}:</p>${fields}</form>`,
      buttons: {
        apply: { label: game.i18n.localize("CPRQH.Apply"), callback: (html) => resolve(Array.from(html.find("input[name='choice']:checked")).slice(0, count).map((input) => input.value)) },
        cancel: { label: game.i18n.localize("CPRQH.Cancel"), callback: () => resolve(null) }
      },
      close: () => resolve(null)
    }).render(true);
  });
}

async function expireDocuments(combat, worldTime = game.time.worldTime) {
  const actors = new Map(game.actors.map((actor) => [actor.uuid, actor]));
  for (const token of canvas?.tokens?.placeables ?? []) actors.set(token.actor.uuid, token.actor);
  for (const actor of actors.values()) {
    const expired = actor.effects.filter((effect) => {
      const flags = effect.flags?.[MODULE_ID];
      if (!flags?.quickhackId) return false;
      if (combat?.started && Number.isFinite(flags.expiresRound)) return combat.round >= flags.expiresRound;
      return Number.isFinite(flags.expiresAt) && worldTime >= flags.expiresAt;
    });
    for (const effect of expired) await deleteManagedEffect(effect);
  }
}

function queueExpiration(combat, worldTime = game.time.worldTime) {
  expirationQueue = expirationQueue
    .catch((error) => {
      console.error(`${MODULE_ID} | La limpieza anterior de efectos falló.`, error);
    })
    .then(() => expireDocuments(combat, worldTime));
  return expirationQueue;
}

async function deleteManagedEffect(effect) {
  const actor = effect?.parent;
  const effectId = effect?.id;
  if (!actor || !effectId) return false;

  const deletionKey = `${actor.uuid}.${effectId}`;
  if (deletingEffects.has(deletionKey)) return false;
  deletingEffects.add(deletionKey);

  try {
    const currentEffect = actor.effects.get(effectId) ?? effect;
    const cyberwareIds = currentEffect.getFlag(MODULE_ID, "cyberwareIds") ?? [];
    for (const id of cyberwareIds) {
      const item = actor.items.get(id);
      if (!item || item.getFlag(MODULE_ID, "disabledByQuickhack") !== effectId) continue;
      const states = item.getFlag(MODULE_ID, "previousEffectStates") ?? {};
      await Promise.all(item.effects.map((entry) => entry.update({ disabled: states[entry.id] ?? false })));
      await item.unsetFlag(MODULE_ID, "disabledByQuickhack");
      await item.unsetFlag(MODULE_ID, "previousEffectStates");
    }

    const tempItems = actor.items
      .filter((item) => item.getFlag(MODULE_ID, "temporaryEffectId") === effectId)
      .map((item) => item.id);
    if (tempItems.length) await actor.deleteEmbeddedDocuments("Item", tempItems);

    const effectToDelete = actor.effects.get(effectId);
    if (!effectToDelete) return true;
    try {
      await effectToDelete.delete();
    } catch (error) {
      if (!isMissingActiveEffectError(error)) throw error;
    }
    return true;
  } finally {
    deletingEffects.delete(deletionKey);
  }
}

async function applyBurnAtTurnStart(combat) {
  const combatant = combat.combatant;
  const actor = combatant?.actor;
  if (!actor) return;
  const key = `${combat.round}:${combat.turn}`;
  const burns = actor.effects.filter((effect) => effect.getFlag(MODULE_ID, "quickhackId") === "overheat" && effect.getFlag(MODULE_ID, "lastBurnTurn") !== key);
  for (const burn of burns) {
    const hp = actor.system.derivedStats.hp.value;
    await actor.update({ "system.derivedStats.hp.value": Math.max(0, hp - 4) });
    await burn.setFlag(MODULE_ID, "lastBurnTurn", key);
    await ChatMessage.create({ content: `<div class="cpr-qh-card"><h3>Overheat</h3><p>${escapeHtml(actor.name)} recibe <b>4</b> de daño por quemadura media.</p></div>` });
  }
}

async function postCard(name, attacker, target, detail, success) {
  const result = success ? game.i18n.localize("CPRQH.Success") : game.i18n.localize("CPRQH.Failure");
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: attacker.actor, token: attacker.document }),
    content: `<div class="cpr-qh-card ${success ? "success" : "failure"}"><h3>${escapeHtml(name)} · ${result}</h3><p>${escapeHtml(attacker.name)} → ${escapeHtml(target.name)}</p><p>${escapeHtml(detail)}</p></div>`
  });
}

async function showDice(roll) {
  if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
}

function isActiveGM() {
  const active = game.users.filter((user) => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
  return Boolean(active && active.id === game.user.id);
}

function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}
