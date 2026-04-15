import { Container, Graphics } from 'pixi.js'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number      // 0–1, counts down
  maxLife: number
  size: number
  color: number
}

// Lightweight CPU particle system.
// Keeps a fixed-size pool to avoid GC pressure.
// Each note-on spawns a burst of particles at the key position.

const POOL_SIZE = 512
const BURST_COUNT = 8

export class ParticleSystem {
  readonly container: Container

  private graphics: Graphics
  private pool: Particle[] = []
  private active: Particle[] = []

  constructor() {
    this.container = new Container()
    this.container.label = 'particles'

    this.graphics = new Graphics()
    this.container.addChild(this.graphics)

    // Pre-allocate pool
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool.push(createParticle())
    }
  }

  // Spawn a burst at (x, y) in the given color
  // Spray particles upward from the collision line (like sparks off a surface).
  // The now-line acts as the "floor" — nothing goes below it.
  burst(x: number, y: number, color: number): void {
    for (let i = 0; i < BURST_COUNT; i++) {
      const p = this.pool.pop() ?? createParticle()
      // Fan upward: angle between 200° and 340° (pointing up, slight L/R spread)
      const angle = (Math.PI * 1.11) + Math.random() * (Math.PI * 0.78)
      const speed = 1.2 + Math.random() * 3.0
      p.x = x + (Math.random() - 0.5) * 6  // slight horizontal scatter at origin
      p.y = y
      p.vx = Math.cos(angle) * speed
      p.vy = Math.sin(angle) * speed        // always negative (upward)
      p.life = 1
      p.maxLife = 0.35 + Math.random() * 0.35
      p.size = 1.5 + Math.random() * 2.5
      p.color = color
      this.active.push(p)
    }
  }

  // Call every frame with delta time in seconds
  update(dt: number): void {
    this.graphics.clear()

    let i = this.active.length
    while (i--) {
      const p = this.active[i]!
      p.life -= dt / p.maxLife
      if (p.life <= 0) {
        this.active.splice(i, 1)
        this.pool.push(p)
        continue
      }

      p.x += p.vx
      p.y += p.vy
      p.vy += 0.08 // gravity

      const alpha = p.life * p.life // ease out
      this.graphics.circle(p.x, p.y, p.size * p.life)
      this.graphics.fill({ color: p.color, alpha })
    }
  }

  clear(): void {
    for (const p of this.active) this.pool.push(p)
    this.active = []
    this.graphics.clear()
  }
}

function createParticle(): Particle {
  return { x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: 0xffffff }
}
