# CPR Quickhacks

Módulo para Foundry VTT 12 y Cyberpunk RED - CORE 0.92.4. Convierte los quickhacks de CEMK en acciones individuales con tirada y efectos.

## Instalación

En Foundry VTT, usa este manifest:

`https://github.com/davidkan1996/cpr-quickhacks/releases/latest/download/module.json`

## Uso

1. Activa el módulo en el mundo.
2. Selecciona el token del Netrunner y marca exactamente un objetivo.
3. Abre **Quickhacks** desde los controles de token (icono de microchip).
4. Ejecuta **Jack In**.
5. Si el objetivo tiene Self-ICE, supera **Breach** antes de lanzar el quickhack.
6. Ejecuta el quickhack.

El rango del rol de Netrunner activo desbloquea Simple (1), Standard (2), Difficult (3) y Advanced (4). La tirada usa el dado crítico nativo del sistema, Interface, Suerte y modificadores introducidos en el diálogo. Como en Cyberpunk RED, el total debe superar la DV; un empate falla.

Self-ICE añade el paso Breach. Cada instalación exige una tirada de Breach superada. Una, dos o tres instalaciones producen una DV 6, 8 o 10 respectivamente, con un máximo de tres Self-ICE. El progreso se conserva mientras siga activo el mismo Jack In. Sin Self-ICE no es necesario superar ningún Passwall.

## Automatización

- Impair Movement y Slow modifican MOVE y expiran tras 20 rondas/60 segundos.
- Sonic Shock añade temporalmente la lesión Damaged Ear del compendio del sistema.
- Overheat inflige 4 PV al inicio del turno mientras su efecto permanezca activo. El efecto se elimina manualmente cuando el objetivo extingue el fuego.
- Short Circuit deja que el GM seleccione hasta 3 piezas no fundacionales. Cyberware Malfunction deja elegir 1 al atacante. Sus Active Effects quedan desactivados y se restauran exactamente al expirar.
- Synapse Burnout resta 3d6 directamente de los PV, sin armadura ni ablación.
- Shard Ejection desinstala el chipware escogido.
- Lure y Puppet crean efectos visibles que identifican quién controla el movimiento o turno. No cambian permisos del Actor.
- System Reset aplica marcadores de inconsciente y prone; expira a los 20 turnos o al bajar sus PV.

Las mutaciones sobre objetivos ajenos se validan y ejecutan en el cliente del GM activo. El módulo no requiere CEMK: usa directamente el rango de Interface y funciona junto a `edgerunners-mission-kit-v11`.

## API

```js
game.cprQuickhacks.open();
game.cprQuickhacks.getDialogState();
game.cprQuickhacks.executeAction("jack-in");
game.cprQuickhacks.executeAction("breach");
game.cprQuickhacks.executeAction("quickhack", "overheat");
game.cprQuickhacks.jackIn(attackerToken, targetToken);
game.cprQuickhacks.breach(attackerToken, targetToken);
game.cprQuickhacks.jackOut(actor);
```

`getDialogState()` y `executeAction()` permiten que otros módulos, como
`cpr-combat-hud`, repliquen el diálogo sin duplicar las reglas ni la ejecución
de los quickhacks.
