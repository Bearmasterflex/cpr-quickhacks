import test from "node:test";
import assert from "node:assert/strict";
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
} from "../scripts/quickhacks.js";

test("defines every supplied quickhack with the correct DV", () => {
  assert.equal(Object.keys(QUICKHACKS).length, 11);
  assert.deepEqual(Object.values(QUICKHACKS).map((q) => q.dv), [6, 6, 8, 8, 10, 10, 10, 10, 12, 12, 12]);
});

test("Interface rank gates tiers", () => {
  assert.equal(canUseQuickhack(2, QUICKHACKS.overheat), true);
  assert.equal(canUseQuickhack(2, QUICKHACKS.slow), false);
});

test("Jack In only accepts Character and Mook actors", () => {
  assert.equal(isValidQuickhackTarget({ type: "character" }), true);
  assert.equal(isValidQuickhackTarget({ type: "mook" }), true);
  assert.equal(isValidQuickhackTarget({ type: "vehicle" }), false);
  assert.equal(isValidQuickhackTarget({ type: "blackIce" }), false);
  assert.equal(isValidQuickhackTarget({ type: "demon" }), false);
  assert.equal(isValidQuickhackTarget(null), false);
});

test("the shared dialog model exposes the same eleven buttons in four tiers", () => {
  const groups = buildQuickhackGroups(2);
  const buttons = groups.flatMap((group) => group.quickhacks);

  assert.equal(groups.length, 4);
  assert.equal(buttons.length, 11);
  assert.equal(buttons.find(({ id }) => id === "overheat").disabled, false);
  assert.equal(buttons.find(({ id }) => id === "slow").disabled, true);
  assert.equal(
    buildQuickhackGroups(4, false)
      .flatMap((group) => group.quickhacks)
      .every(({ disabled }) => disabled),
    true
  );
});

test("Jack Out target cleanup clears the current user's selection", () => {
  const calls = [];
  clearTargetSelection({
    targets: new Set([{ id: "target-1" }]),
    updateTokenTargets(ids) {
      calls.push(ids);
    }
  });

  assert.deepEqual(calls, [[]]);
});

test("a roll must beat the DV, as in Cyberpunk RED", () => {
  assert.equal(succeeds(9, 8), true);
  assert.equal(succeeds(8, 8), false);
});

test("cyberware selection excludes foundational and uninstalled pieces", () => {
  const items = [
    { type: "cyberware", system: { isInstalled: true, isFoundational: false } },
    { type: "cyberware", system: { isInstalled: true, isFoundational: true } },
    { type: "cyberware", system: { isInstalled: false, isFoundational: false } }
  ];
  assert.equal(eligibleCyberware(items).length, 1);
});

test("twenty rounds equals sixty seconds", () => {
  const duration = expirationData(20, { started: true, round: 3 }, 100);
  assert.equal(duration.seconds, 60);
  assert.equal(duration.expiresAt, 160);
  assert.equal(duration.expiresRound, 23);
});

test("Self-ICE count and Breach DV cap at three installations", () => {
  const installed = (name) => ({ name, system: { isInstalled: true } });
  assert.equal(countSelfIce([]), 0);
  assert.equal(countSelfIce([installed("Self-ICE")]), 1);
  assert.equal(countSelfIce([installed("Self-ICE"), installed("Auto-ICE")]), 2);
  assert.equal(countSelfIce([installed("Self-ICE"), installed("Self-ICE"), installed("Self-ICE"), installed("Self-ICE")]), 3);
  assert.equal(countSelfIce([{ name: "Self-ICE", system: { isInstalled: false } }]), 0);
  assert.equal(getBreachDv(0), null);
  assert.equal(getBreachDv(1), 6);
  assert.equal(getBreachDv(2), 8);
  assert.equal(getBreachDv(3), 10);
  assert.equal(getBreachDv(4), 10);
});

test("Breach needs one successful roll per installed Self-ICE", () => {
  const targetUuid = "Scene.scene.Token.target";
  const first = advanceBreachProgress(null, targetUuid, 3);
  const second = advanceBreachProgress(first, targetUuid, 3);
  const third = advanceBreachProgress(second, targetUuid, 3);

  assert.equal(getBreachProgress(first, targetUuid, 3), 1);
  assert.equal(getBreachProgress(second, targetUuid, 3), 2);
  assert.equal(getBreachProgress(second, "Scene.scene.Token.other", 3), 0);
  assert.equal(isBreachComplete(second, targetUuid, 3), false);
  assert.equal(isBreachComplete(third, targetUuid, 3), true);
  assert.equal(isBreachComplete(null, targetUuid, 1, targetUuid), true);
  assert.equal(isBreachComplete(null, targetUuid, 2, targetUuid), false);
});

test("Interface rolls receive the complete program-shaped context expected by CPR", () => {
  const context = getInterfaceRollProgramContext("Overheat");
  assert.equal(context.name, "Overheat");
  assert.equal(context.system.class, "quickhack");
  assert.deepEqual(context.system.damage, { standard: "", blackIce: "" });
});

test("missing Active Effects are recognized as an idempotent deletion case", () => {
  assert.equal(isMissingActiveEffectError(new Error('ActiveEffect "abc123" does not exist!')), true);
  assert.equal(isMissingActiveEffectError(new Error("Permission denied")), false);
});
