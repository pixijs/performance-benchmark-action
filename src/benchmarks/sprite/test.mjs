import Engine from '../Engine.mjs'
import * as PIXI from 'pixi.js'

export class Test extends Engine {
  async init() {
    await super.init()

    // load bunny texture
    await PIXI.Assets.load({
      alias: 'bunny',
      src: 'https://pixijs.io/examples/examples/assets/bunny.png'
    })

    this.texture = PIXI.Assets.get('bunny')
    const particles = new Array(this.count)
    const rnd = [1, -1]
    for (let i = 0; i < this.count; i++) {
      const size = 10 + Math.random() * 80
      const x = Math.random() * this.width
      const y = Math.random() * (this.height - size)
      const [dx, dy] = [
        3 * Math.random() * rnd[Math.floor(Math.random() * 2)],
        3 * Math.random() * rnd[Math.floor(Math.random() * 2)]
      ]
      let particle
      particle = new PIXI.Sprite(this.texture)
      particle.position.set(x, y)
      this.app.stage.addChild(particle)
      particles[i] = { x, y, size: size, dx, dy, el: particle }
    }
    this.particles = particles
  }

  async render() {
    return new Promise((resolve) => {
      this.app.ticker.add((_time) => {
        // Particle animation
        const particles = this.particles
        for (let i = 0; i < this.count; i++) {
          const r = particles[i]
          r.x -= r.dx
          r.y -= r.dy
          if (r.x + r.size < 0) r.dx *= -1
          else if (r.y + r.size < 0) r.dy *= -1
          if (r.x > this.width) r.dx *= -1
          else if (r.y > this.height) r.dy *= -1
          r.el.position.x = r.x
          r.el.position.y = r.y
        }

        this.tick()

        if (this.frameCount >= this.maxFrames) {
          this.app.destroy(true, true)
          resolve()
        }
      })
    })
  }
}
