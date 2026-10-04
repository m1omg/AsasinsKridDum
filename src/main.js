import './style.css';
import { Game } from './game/game.js';

async function boot() {
  const canvas = document.getElementById('game');
  const ui = document.getElementById('ui');
  let game;
  try {
    game = new Game(canvas, ui);
  } catch (e) {
    ui.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;font:20px Georgia,serif;color:#f2e6cf;background:#0b0605;padding:16px;text-align:center">
      <div><div style="font:700 42px Georgia,serif;color:#d8a446;margin-bottom:12px">HELLCREED</div>
      Your browser could not start WebGL, which this game needs.<br>Try a recent Chrome, Edge or Firefox with hardware acceleration enabled.</div></div>`;
    throw e;
  }
  window.__game = game;
  game.start();
  await game.load();
  // test hook: run the fixed-step simulation synchronously (no rendering)
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      game.loop.simTime += 1 / 60;
      game.fixedUpdate(1 / 60, game.loop.simTime);
    }
  };
  window.__debug = { ready: true, game, step };
}

boot().catch((e) => {
  console.error(e);
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#f88;position:fixed;bottom:0;left:0;right:0;max-height:40vh;overflow:auto;z-index:9;background:#000c;padding:8px;font:12px monospace;white-space:pre-wrap';
  pre.textContent = String(e && e.stack ? e.stack : e);
  document.body.appendChild(pre);
});
