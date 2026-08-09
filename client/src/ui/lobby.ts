import { MAX_PLAYERS, MIN_PLAYERS, PRACTICE_MIN_PLAYERS, ROOM_CODE_LENGTH } from '@shared/constants';

import type { NetSnapshot } from '../net/connection';

export interface LobbyCallbacks {
  onCreate: (nickname: string) => void;
  onJoin: (nickname: string, code: string) => void;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  /** @param bots how many bot runners; @param asDrone true to fly it yourself. */
  onSolo: (bots: number, asDrone: boolean) => void;
  onPractice: (on: boolean) => void;
  onRole: (role: 'drone' | 'runner') => void;
  onBots: (count: number) => void;
  /** Leave the room and go back to the landing screen. */
  onLeave: () => void;
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
  private readonly hint: HTMLElement;
  private readonly setup: HTMLElement;
  private readonly practiceRow: HTMLElement;
  private readonly practiceButton: HTMLButtonElement;
  private readonly botRow: HTMLElement;
  private readonly botCount: HTMLElement;
  private readonly roleDrone: HTMLButtonElement;
  private readonly roleRunner: HTMLButtonElement;
  private readonly droneLine: HTMLElement;
  private ready = false;
  /** Last bot count we saw from the server, so ± can step from it. */
  private bots = 0;
  /** Solo setup, kept here because there is no server to hold it. */
  private soloBots = 2;
  private soloAsDrone = false;

  constructor(private readonly callbacks: LobbyCallbacks, parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'lobby';
    this.root.innerHTML = `
      <div class="lobby-card" data-view="landing">
        <h1>BUZZKILL</h1>
        <p class="lobby-sub">friends-only lobbies · ${MIN_PLAYERS}-${MAX_PLAYERS} players, or 1 + bots</p>
        <input class="lobby-nick" maxlength="16" placeholder="your name" />
        <button class="lobby-create">CREATE ROOM</button>
        <div class="lobby-join">
          <input class="lobby-code" maxlength="${ROOM_CODE_LENGTH}" placeholder="CODE" />
          <button class="lobby-joinbtn">JOIN</button>
        </div>
        <div class="lobby-setup lobby-solo-setup">
          <div class="lobby-row">
            <span>solo — you</span>
            <button class="lobby-solo-run" data-on="1">RUN</button>
            <button class="lobby-solo-fly" data-on="0">FLY</button>
          </div>
          <div class="lobby-row">
            <span>bot runners</span>
            <button class="lobby-solo-down">&minus;</button>
            <span class="lobby-solo-count">2</span>
            <button class="lobby-solo-up">+</button>
          </div>
        </div>
        <button class="lobby-solo">PLAY SOLO (NO SERVER)</button>
        <p class="lobby-status"></p>
      </div>

      <div class="lobby-card" data-view="room" hidden>
        <p class="lobby-sub">ROOM CODE</p>
        <h1 class="lobby-codelabel">----</h1>
        <ul class="lobby-players"></ul>
        <div class="lobby-setup lobby-room-setup">
          <div class="lobby-row lobby-practicerow">
            <span>practice (1 player + bots)</span>
            <button class="lobby-practice" data-on="0">OFF</button>
          </div>
          <div class="lobby-row">
            <span>the drone</span>
            <button class="lobby-role-drone">I FLY IT</button>
            <button class="lobby-role-runner">A BOT FLIES</button>
          </div>
          <p class="lobby-droneline"></p>
          <div class="lobby-row lobby-botrow">
            <span>bots</span>
            <button class="lobby-bots-down">−</button>
            <span class="lobby-botcount">0</span>
            <button class="lobby-bots-up">+</button>
          </div>
        </div>
        <button class="lobby-ready">READY</button>
        <button class="lobby-start" disabled>START MATCH</button>
        <button class="lobby-leave">LEAVE ROOM</button>
        <p class="lobby-hint"></p>
      </div>

      <div class="lobby-card" data-view="results" hidden>
        <h1 class="lobby-result-title">ROUND OVER</h1>
        <p class="lobby-result-cause"></p>
        <ul class="lobby-scores"></ul>
        <p class="lobby-awards"></p>
        <button class="lobby-results-back">BACK TO THE LOBBY</button>
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
    this.hint = this.pick('.lobby-hint');
    this.setup = this.pick('.lobby-room-setup');
    this.practiceRow = this.pick('.lobby-practicerow');
    this.practiceButton = this.pick('.lobby-practice');
    this.botRow = this.pick('.lobby-botrow');
    this.botCount = this.pick('.lobby-botcount');
    this.roleDrone = this.pick('.lobby-role-drone');
    this.roleRunner = this.pick('.lobby-role-runner');
    this.droneLine = this.pick('.lobby-droneline');

    // Every screen needs a way back out of it. Without these the only exit
    // from a room was reloading the page.
    this.pick<HTMLButtonElement>('.lobby-leave').onclick = () => this.callbacks.onLeave();
    this.pick<HTMLButtonElement>('.lobby-results-back').onclick = () => {
      this.landing.hidden = true;
      this.room.hidden = false;
      this.results.hidden = true;
    };

    // Every control below only *asks*: the server decides and the next
    // snapshot paints the answer, so a rejected request simply does nothing.
    this.practiceButton.onclick = () => {
      this.callbacks.onPractice(this.practiceButton.dataset.on !== '1');
    };
    this.roleDrone.onclick = () => this.callbacks.onRole('drone');
    this.roleRunner.onclick = () => this.callbacks.onRole('runner');
    this.pick<HTMLButtonElement>('.lobby-bots-down').onclick = () => {
      this.callbacks.onBots(Math.max(0, this.bots - 1));
    };
    this.pick<HTMLButtonElement>('.lobby-bots-up').onclick = () => {
      this.callbacks.onBots(Math.min(MAX_PLAYERS - 1, this.bots + 1));
    };

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
    const soloRun = this.pick<HTMLButtonElement>('.lobby-solo-run');
    const soloFly = this.pick<HTMLButtonElement>('.lobby-solo-fly');
    const soloCount = this.pick('.lobby-solo-count');
    const setSoloRole = (drone: boolean): void => {
      this.soloAsDrone = drone;
      soloRun.dataset.on = drone ? '0' : '1';
      soloFly.dataset.on = drone ? '1' : '0';
    };
    soloRun.onclick = () => setSoloRole(false);
    soloFly.onclick = () => setSoloRole(true);
    this.pick<HTMLButtonElement>('.lobby-solo-down').onclick = () => {
      this.soloBots = Math.max(0, this.soloBots - 1);
      soloCount.textContent = String(this.soloBots);
    };
    this.pick<HTMLButtonElement>('.lobby-solo-up').onclick = () => {
      this.soloBots = Math.min(MAX_PLAYERS - 1, this.soloBots + 1);
      soloCount.textContent = String(this.soloBots);
    };
    this.pick<HTMLButtonElement>('.lobby-solo').onclick = () => {
      this.hide();
      this.callbacks.onSolo(this.soloBots, this.soloAsDrone);
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

  /**
   * No server is configured at all, so hide the parts that need one.
   *
   * Previously this case skipped the landing screen entirely and dropped the
   * player straight into an empty arena — which meant the solo setup, the
   * thing that gives them bots and a choice of role, was unreachable exactly
   * when it was the only thing that worked.
   */
  /**
   * Back to the very start, from a round or a room.
   *
   * @param soloOnly whether there is no server to offer in the first place.
   */
  returnToLanding(soloOnly: boolean): void {
    this.ready = false;
    this.readyButton.textContent = 'READY';
    this.landing.hidden = false;
    this.room.hidden = true;
    this.results.hidden = true;
    if (soloOnly) this.setSoloOnly();
    else this.show();
  }

  setSoloOnly(): void {
    this.pick('.lobby-nick').hidden = true;
    this.pick('.lobby-create').hidden = true;
    this.pick('.lobby-join').hidden = true;
    this.pick('.lobby-sub').textContent = 'no server configured · solo play';
    this.status.textContent = '';
    this.show();
  }

  /**
   * The server could not be reached.
   *
   * Solo play is normally a footnote, because the game is a party game. When
   * there is no server it is the only thing that works, so it stops being a
   * footnote and says so — a landing page whose two buttons both fail, with a
   * grey link underneath, reads as broken rather than as degraded.
   */
  setServerUnreachable(message: string): void {
    this.status.textContent = `${message} — the game server may be asleep or restarting.`;
    const solo = this.pick<HTMLButtonElement>('.lobby-solo');
    solo.classList.add('lobby-solo-primary');
    solo.textContent = 'PLAY SOLO INSTEAD';
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
      this.renderSetup(snapshot, selfId);
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

  /**
   * Practice toggle, role picker and bot count.
   *
   * Practice and bots are host-only because they change the shape of the round
   * for everyone; the role picker is not, because picking what you play is
   * every player's own business. The start button reads the practice minimum
   * so one person plus bots is a legal round, while a real match still needs
   * the brief's three humans.
   */
  private renderSetup(snapshot: NetSnapshot, selfId: string): void {
    const isHost = snapshot.host === selfId;
    this.bots = snapshot.botCount;

    this.practiceRow.hidden = !isHost;
    this.botRow.hidden = !isHost;
    this.setup.hidden = false;
    this.practiceButton.dataset.on = snapshot.practice ? '1' : '0';
    this.practiceButton.textContent = snapshot.practice ? 'ON' : 'OFF';
    this.botCount.textContent = String(snapshot.botCount);

    const me = snapshot.players.find((player) => player.sessionId === selfId);
    this.roleDrone.dataset.on = me?.role === 'drone' ? '1' : '0';
    this.roleRunner.dataset.on = me?.role === 'runner' ? '1' : '0';

    // Say out loud who is flying. "A bot will take it" was true before this
    // and completely invisible, which is the same as not being offered.
    const pilot = snapshot.players.find((player) => player.role === 'drone');
    this.droneLine.textContent = !pilot
      ? snapshot.botCount > 0
        ? 'nobody is flying yet'
        : 'nobody is flying — add a bot, or someone has to take it'
      : pilot.sessionId === selfId
        ? 'you are flying the drone'
        : `${pilot.nickname} is flying the drone`;

    const humans = snapshot.players.filter((player) => !player.bot).length;
    const minimum = snapshot.practice ? PRACTICE_MIN_PLAYERS : MIN_PLAYERS;
    this.startButton.hidden = !isHost;
    this.startButton.disabled = humans < minimum;
    this.hint.textContent = isHost
      ? humans < minimum
        ? `${minimum - humans} more player${minimum - humans === 1 ? '' : 's'} needed` +
          `${snapshot.practice ? '' : ' — or switch on practice'}`
        : snapshot.practice
          ? 'practice round · not scored'
          : `round ${snapshot.round + 1} of the match`
      : 'waiting for the host to start';
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
