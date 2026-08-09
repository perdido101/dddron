import { MIN_PLAYERS, ROOM_CODE_LENGTH } from '@shared/constants';

import type { NetSnapshot } from '../net/connection';

export interface LobbyCallbacks {
  onCreate: (nickname: string) => void;
  onJoin: (nickname: string, code: string) => void;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onSolo: () => void;
}

/**
 * Landing screen, lobby and the round-end / results screens.
 *
 * Everything here is a view of server state — the client never decides who is
 * host, who flies, or what the score is. The one exception is "play solo",
 * which skips networking entirely and is how the single-player build stays
 * reachable.
 */
export class Lobby {
  private readonly root: HTMLElement;
  private readonly landing: HTMLElement;
  private readonly room: HTMLElement;
  private readonly results: HTMLElement;
  private readonly nickname: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly codeLabel: HTMLElement;
  private readonly playerList: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly readyButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private ready = false;

  constructor(private readonly callbacks: LobbyCallbacks, parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'lobby';
    this.root.innerHTML = `
      <div class="lobby-card" data-view="landing">
        <h1>BUZZKILL</h1>
        <p class="lobby-sub">friends-only lobbies · 3-8 players</p>
        <input class="lobby-nick" maxlength="16" placeholder="your name" />
        <button class="lobby-create">CREATE ROOM</button>
        <div class="lobby-join">
          <input class="lobby-code" maxlength="${ROOM_CODE_LENGTH}" placeholder="CODE" />
          <button class="lobby-joinbtn">JOIN</button>
        </div>
        <button class="lobby-solo">play solo (no server)</button>
        <p class="lobby-status"></p>
      </div>

      <div class="lobby-card" data-view="room" hidden>
        <p class="lobby-sub">ROOM CODE</p>
        <h1 class="lobby-codelabel">----</h1>
        <ul class="lobby-players"></ul>
        <button class="lobby-ready">READY</button>
        <button class="lobby-start" disabled>START MATCH</button>
        <p class="lobby-hint">the host starts · ${MIN_PLAYERS} players minimum</p>
      </div>

      <div class="lobby-card" data-view="results" hidden>
        <h1 class="lobby-result-title">ROUND OVER</h1>
        <p class="lobby-result-cause"></p>
        <ul class="lobby-scores"></ul>
        <p class="lobby-awards"></p>
      </div>
    `;
    parent.appendChild(this.root);

    this.landing = this.pick('[data-view="landing"]');
    this.room = this.pick('[data-view="room"]');
    this.results = this.pick('[data-view="results"]');
    this.nickname = this.pick('.lobby-nick');
    this.codeInput = this.pick('.lobby-code');
    this.codeLabel = this.pick('.lobby-codelabel');
    this.playerList = this.pick('.lobby-players');
    this.startButton = this.pick('.lobby-start');
    this.readyButton = this.pick('.lobby-ready');
    this.status = this.pick('.lobby-status');

    this.pick<HTMLButtonElement>('.lobby-create').onclick = () => {
      this.status.textContent = 'creating room…';
      this.callbacks.onCreate(this.name());
    };
    this.pick<HTMLButtonElement>('.lobby-joinbtn').onclick = () => {
      const code = this.codeInput.value.trim().toUpperCase();
      if (code.length !== ROOM_CODE_LENGTH) {
        this.status.textContent = `codes are ${ROOM_CODE_LENGTH} letters`;
        return;
      }
      this.status.textContent = 'joining…';
      this.callbacks.onJoin(this.name(), code);
    };
    this.pick<HTMLButtonElement>('.lobby-solo').onclick = () => {
      this.hide();
      this.callbacks.onSolo();
    };
    this.readyButton.onclick = () => {
      this.ready = !this.ready;
      this.readyButton.textContent = this.ready ? 'READY ✓' : 'READY';
      this.callbacks.onReady(this.ready);
    };
    this.startButton.onclick = () => this.callbacks.onStart();

    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase();
    });
  }

  private pick<T extends HTMLElement>(selector: string): T {
    const found = this.root.querySelector(selector);
    if (!found) throw new Error(`lobby element missing: ${selector}`);
    return found as T;
  }

  private name(): string {
    return this.nickname.value.trim() || 'player';
  }

  setStatus(message: string): void {
    this.status.textContent = message;
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  show(): void {
    this.root.style.display = 'grid';
  }

  /** Swap to the in-room view once connected. */
  enterRoom(): void {
    this.landing.hidden = true;
    this.room.hidden = false;
    this.results.hidden = true;
    this.show();
  }

  /** Drive the whole screen from server state. */
  update(snapshot: NetSnapshot, selfId: string): void {
    if (snapshot.phase === 'playing') {
      this.hide();
      return;
    }

    this.show();
    this.codeLabel.textContent = snapshot.code || '----';

    if (snapshot.phase === 'lobby') {
      this.landing.hidden = true;
      this.room.hidden = false;
      this.results.hidden = true;
      this.renderPlayers(snapshot, selfId);
      const isHost = snapshot.host === selfId;
      this.startButton.hidden = !isHost;
      this.startButton.disabled = snapshot.players.length < MIN_PLAYERS;
      return;
    }

    // intermission or ended: the round-end / results screen.
    this.landing.hidden = true;
    this.room.hidden = true;
    this.results.hidden = false;
    this.renderResults(snapshot);
  }

  private renderPlayers(snapshot: NetSnapshot, selfId: string): void {
    this.playerList.innerHTML = '';
    for (const player of snapshot.players) {
      const row = document.createElement('li');
      const you = player.sessionId === selfId ? ' (you)' : '';
      const host = player.sessionId === snapshot.host ? ' · host' : '';
      row.textContent = `${player.nickname}${you}${host} — ${player.role}${player.ready ? ' ✓' : ''}`;
      this.playerList.appendChild(row);
    }
  }

  private renderResults(snapshot: NetSnapshot): void {
    const matchOver = snapshot.phase === 'ended';
    const title = this.pick('.lobby-result-title');
    title.textContent = matchOver
      ? 'MATCH OVER'
      : snapshot.winner === 'runners' ? 'RUNNERS WIN THE ROUND' : 'THE DRONE WINS THE ROUND';
    this.pick('.lobby-result-cause').textContent = snapshot.cause
      ? `${snapshot.cause} · round ${snapshot.round}/${snapshot.totalRounds}`
      : '';

    const scores = [...snapshot.players].sort((a, b) => b.score - a.score);
    const list = this.pick('.lobby-scores');
    list.innerHTML = '';
    for (const player of scores) {
      const row = document.createElement('li');
      row.textContent = `${player.score.toString().padStart(3, ' ')}  ${player.nickname}`;
      list.appendChild(row);
    }

    // Joke awards, from the counters the server keeps.
    if (!matchOver) {
      this.pick('.lobby-awards').textContent = '';
      return;
    }
    const mvp = scores[0];
    const survivor = [...snapshot.players].sort((a, b) => b.survived - a.survived)[0];
    const butterfingers = [...snapshot.players].sort((a, b) => b.coresDropped - a.coresDropped)[0];
    const launched = [...snapshot.players].sort((a, b) => b.fanLaunches - a.fanLaunches)[0];
    const awards = [
      mvp ? `MVP: ${mvp.nickname}` : '',
      survivor && survivor.survived > 0 ? `most detonations survived: ${survivor.nickname}` : '',
      butterfingers && butterfingers.coresDropped > 0 ? `most cores dropped: ${butterfingers.nickname}` : '',
      launched && launched.fanLaunches > 0 ? `most self-inflicted fan launches: ${launched.nickname}` : '',
    ].filter(Boolean);
    this.pick('.lobby-awards').textContent = awards.join(' · ');
  }
}
