(function (root) {
  'use strict';

  class CasinoFxEngine {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.particles = [];
      this.ambientMotes = [];
      this.rafId = null;
      this.width = 0;
      this.height = 0;
    }

    init(canvasEl) {
      if (!canvasEl) return;
      this.canvas = canvasEl;
      this.ctx = canvasEl.getContext('2d');
      this.resize();
      window.addEventListener('resize', () => this.resize());
      this._seedAmbient();
      this._loop();
    }

    resize() {
      if (!this.canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = Math.floor(this.width * dpr);
      this.canvas.height = Math.floor(this.height * dpr);
      this.canvas.style.width = this.width + 'px';
      this.canvas.style.height = this.height + 'px';
      if (this.ctx) {
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    _seedAmbient() {
      this.ambientMotes = [];
      const count = 28;
      for (let i = 0; i < count; i++) {
        this.ambientMotes.push({
          x: Math.random() * (this.width || 1200),
          y: Math.random() * (this.height || 800),
          r: 1 + Math.random() * 2.2,
          vx: (Math.random() - 0.5) * 0.18,
          vy: -0.12 - Math.random() * 0.25,
          alpha: 0.12 + Math.random() * 0.28,
          hue: Math.random() > 0.35 ? '#f5c451' : '#ec4899'
        });
      }
    }

    emitBurst(x, y, color = '#f5c451', count = 24) {
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
        const speed = 2.2 + Math.random() * 5.2;
        this.particles.push({
          kind: 'spark',
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.2,
          size: 2 + Math.random() * 3.5,
          color,
          alpha: 1,
          decay: 0.022 + Math.random() * 0.015,
          gravity: 0.12
        });
      }
    }

    emitBurstAtElement(el, color = '#f5c451', count = 24) {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      this.emitBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, color, count);
    }

    emitConfetti(count = 110) {
      const palette = ['#f5c451', '#ec4899', '#06b6d4', '#22c55e', '#a855f7', '#ffffff'];
      const w = this.width || window.innerWidth;
      for (let i = 0; i < count; i++) {
        this.particles.push({
          kind: 'confetti',
          x: Math.random() * w,
          y: -15 - Math.random() * 140,
          vx: (Math.random() - 0.5) * 4.5,
          vy: 2.4 + Math.random() * 4.2,
          w: 6 + Math.random() * 6,
          h: 3 + Math.random() * 4,
          rot: Math.random() * Math.PI * 2,
          vrot: (Math.random() - 0.5) * 0.22,
          color: palette[i % palette.length],
          alpha: 1,
          decay: 0.0045 + Math.random() * 0.003,
          gravity: 0.055
        });
      }
    }

    spawnFloatingText(elOrRect, text, color = '#fbbf24') {
      if (!elOrRect) return;
      const rect = typeof elOrRect.getBoundingClientRect === 'function'
        ? elOrRect.getBoundingClientRect()
        : elOrRect;

      const popup = document.createElement('div');
      popup.className = 'fx-floating-text';
      popup.textContent = text;
      popup.style.left = (rect.left + rect.width / 2) + 'px';
      popup.style.top = (rect.top + rect.height * 0.35) + 'px';
      popup.style.color = color;
      document.body.appendChild(popup);
      setTimeout(() => popup.remove(), 1450);
    }

    animateDiceFlight(fromEl, toEl, colorHex, count = 1) {
      if (!fromEl || !toEl) return;
      const r1 = fromEl.getBoundingClientRect();
      const r2 = toEl.getBoundingClientRect();
      const total = Math.min(count, 4);

      for (let i = 0; i < total; i++) {
        const chip = document.createElement('div');
        chip.className = 'fx-flying-die';
        chip.style.setProperty('--die-color', colorHex);
        const startX = r1.left + r1.width / 2 + (i - (total - 1) / 2) * 16;
        const startY = r1.top + r1.height / 2;
        const endX = r2.left + r2.width / 2 + (Math.random() - 0.5) * 28;
        const endY = r2.top + r2.height * 0.68 + (Math.random() - 0.5) * 14;

        chip.style.left = startX + 'px';
        chip.style.top = startY + 'px';
        document.body.appendChild(chip);

        const duration = 380 + i * 45;
        const dx = endX - startX;
        const dy = endY - startY;

        chip.animate(
          [
            { transform: 'translate(-50%, -50%) scale(1.15) rotate(0deg)', opacity: 1 },
            { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - 55}px)) scale(1.3) rotate(180deg)`, opacity: 1 },
            { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.8) rotate(360deg)`, opacity: 0.2 }
          ],
          { duration, easing: 'cubic-bezier(0.22, 0.9, 0.3, 1)', fill: 'forwards' }
        );

        setTimeout(() => {
          chip.remove();
          if (i === 0) {
            this.emitBurst(endX, endY, colorHex, 18);
          }
        }, duration);
      }
    }

    animateBillFlight(fromEl, toEl, labelText = '$50,000') {
      if (!fromEl || !toEl) return;
      const r1 = fromEl.getBoundingClientRect();
      const r2 = toEl.getBoundingClientRect();
      const startX = r1.left + r1.width / 2;
      const startY = r1.top + r1.height * 0.35;
      const endX = r2.left + r2.width / 2;
      const endY = r2.top + r2.height / 2;

      const bill = document.createElement('div');
      bill.className = 'fx-flying-bill';
      bill.textContent = labelText;
      bill.style.left = startX + 'px';
      bill.style.top = startY + 'px';
      document.body.appendChild(bill);

      const dx = endX - startX;
      const dy = endY - startY;
      bill.animate(
        [
          { transform: 'translate(-50%, -50%) scale(1.05) rotate(-4deg)', opacity: 1 },
          { transform: `translate(calc(-50% + ${dx * 0.45}px), calc(-50% + ${dy * 0.45 - 40}px)) scale(1.18) rotate(3deg)`, opacity: 1 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.55) rotate(0deg)`, opacity: 0.1 }
        ],
        { duration: 640, easing: 'cubic-bezier(0.2, 0.85, 0.25, 1)', fill: 'forwards' }
      );
      setTimeout(() => {
        bill.remove();
        this.emitBurst(endX, endY, '#f5c451', 20);
      }, 640);
    }

    _loop() {
      if (!this.ctx) return;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);

      // Ambient warm champagne motes
      for (const m of this.ambientMotes) {
        m.x += m.vx;
        m.y += m.vy;
        if (m.y < -10) {
          m.y = this.height + 10;
          m.x = Math.random() * this.width;
        }
        if (m.x < -10) m.x = this.width + 10;
        if (m.x > this.width + 10) m.x = -10;

        ctx.save();
        ctx.globalAlpha = m.alpha;
        ctx.fillStyle = m.hue;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Active burst & confetti particles
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.alpha -= p.decay;

        if (p.alpha <= 0 || p.y > this.height + 40) {
          this.particles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.fillStyle = p.color;

        if (p.kind === 'spark') {
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        } else {
          p.rot += p.vrot;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
      }

      this.rafId = requestAnimationFrame(() => this._loop());
    }
  }

  root.CasinoFx = new CasinoFxEngine();
})(typeof self !== 'undefined' ? self : this);
