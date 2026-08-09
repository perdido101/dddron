/** What the pause menu can ask the game to do. */
export interface MenuCallbacks {
  onResume: () => void;
  /** Leave the room or the solo session and return to the landing screen. */
  onQuit: () => void;
  onToggleFpv: () => void;
  onToggleHazards: () => boolean;
  onRespawn: () => void;
}

/**
 * In-game menu, on Escape.
 *
 * Until now the only way out of a round was to reload the page: the lobby
 * hides itself when play starts and nothing brings it back. That is fine for a
 * build you are testing and unacceptable for one people play — leaving a game
 * is not an advanced feature.
 *
 * Deliberately small. A party game's pause menu wants resume, quit, the two
 * settings people actually change mid-round, and the controls, because nobody
 * reads a key list before playing and everybody wants one during.
 */
export class Menu {
  private readonly root: HTMLElement;
  private readonly hazardButton: HTMLButtonElement;
  private open = false;

  constructor(private readonly callbacks: MenuCallbacks, parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'menu';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="menu-card">
        <h2>PAUSED</h2>
        <button class="menu-resume">RESUME</button>
        <button class="menu-fpv">TOGGLE DRONE CAMERA (V)</button>
        <button class="menu-hazards" data-on="1">HAZARDS: ON</button>
        <button class="menu-respawn">RESPAWN (R)</button>
        <button class="menu-quit">LEAVE GAME</button>
        <div class="menu-keys">
          <div><b>WASD</b> move · <b>SPACE</b> jump / drone up · <b>SHIFT</b> drone down</div>
          <div><b>E</b> hold to lift or insert a core · <b>F</b> swat · <b>Q</b> grab / throw</div>
          <div><b>C</b> swap body (solo) · <b>V</b> drone camera · <b>G</b> gremlin · <b>R</b> respawn</div>
          <div><b>O</b> free camera · <b>~</b> debug overlay · <b>ESC</b> this menu</div>
        </div>
      </div>
    `;
    parent.appendChild(this.root);
    this.hazardButton = this.root.querySelector('.menu-hazards') as HTMLButtonElement;

    this.button('.menu-resume', () => this.hide());
    this.button('.menu-fpv', () => this.callbacks.onToggleFpv());
    this.button('.menu-respawn', () => {
      this.callbacks.onRespawn();
      this.hide();
    });
    this.button('.menu-quit', () => {
      this.hide();
      this.callbacks.onQuit();
    });
    this.button('.menu-hazards', () => {
      const on = this.callbacks.onToggleHazards();
      this.hazardButton.dataset.on = on ? '1' : '0';
      this.hazardButton.textContent = `HAZARDS: ${on ? 'ON' : 'OFF'}`;
    });
  }

  private button(selector: string, onClick: () => void): void {
    const element = this.root.querySelector(selector) as HTMLButtonElement | null;
    if (element) element.onclick = onClick;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.root.hidden = false;
    // Pointer lock and a menu you have to click are incompatible.
    document.exitPointerLock();
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
    this.callbacks.onResume();
  }

  get visible(): boolean {
    return this.open;
  }
}
