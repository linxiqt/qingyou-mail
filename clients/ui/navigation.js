// Pointer-following material and navigation commitment are intentionally separate.
// Neither light tracking nor candidate feedback changes application/ARIA state.
const BAR = "[data-scrub-nav]";
const MATERIAL = ".phone-nav,.sidebar";
const buttonList = (nav) => [
  ...nav.querySelectorAll(":scope > button[data-action]"),
];

export function hitNavigation(nav, x, y) {
  if (!nav?.isConnected || nav.closest("[inert]")) return null;
  const rect = nav.getBoundingClientRect();
  if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom)
    return null;
  // Capture retargets the event, not elementFromPoint. Reject outside rounded
  // corners, modal overlays and any other surface covering the bar.
  if (!nav.contains(document.elementFromPoint(x, y))) return null;
  const buttons = buttonList(nav);
  const vertical = getComputedStyle(nav).flexDirection === "column";
  let nearest = null,
    distance = Infinity;
  for (const button of buttons) {
    const r = button.getBoundingClientRect();
    const d = Math.abs(
      vertical ? y - (r.top + r.height / 2) : x - (r.left + r.width / 2),
    );
    if (d < distance) {
      distance = d;
      nearest = button;
    }
  }
  // Small gaps belong to the nearest slot; a disabled slot never redirects.
  return nearest?.disabled ? null : nearest;
}

function installMaterialLight() {
  let surface = null,
    point = null,
    frame = 0,
    pressed = null,
    touch = null;
  const surfaceAt = (target) =>
    target instanceof Element ? target.closest(MATERIAL) : null;
  const fade = () => {
    if (surface) surface.removeAttribute("data-light-on");
    point = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const paint = () => {
    frame = 0;
    if (!surface?.isConnected || !point) return;
    const rect = surface.getBoundingClientRect();
    const inside =
      point.x >= rect.left &&
      point.x < rect.right &&
      point.y >= rect.top &&
      point.y < rect.bottom;
    if (!inside) {
      surface.removeAttribute("data-light-on");
      return;
    }
    surface.classList.add("light-surface");
    // CSSOM assignment is allowed by the client's strict style-src policy.
    surface.style.setProperty("--light-x", `${point.x - rect.left}px`);
    surface.style.setProperty("--light-y", `${point.y - rect.top}px`);
    surface.style.setProperty("--light-top", `${surface.scrollTop}px`);
    surface.setAttribute("data-light-on", "");
  };
  const track = (node, x, y) => {
    if (!node || node.closest("[inert]")) {
      fade();
      return;
    }
    if (surface !== node) {
      fade();
      surface = node;
    }
    point = { x, y };
    if (!frame) frame = requestAnimationFrame(paint);
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (
        e.isPrimary === false ||
        e.button !== 0 ||
        pressed ||
        (e.pointerType === "touch" && touch)
      )
        return;
      const node = surfaceAt(e.target);
      if (node) {
        pressed = { id: e.pointerId, node };
        track(node, e.clientX, e.clientY);
      }
    },
    { passive: true },
  );
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.isPrimary === false || (e.pointerType === "touch" && touch)) return;
      if (pressed) {
        if (pressed.id === e.pointerId)
          track(pressed.node, e.clientX, e.clientY);
      } else if (e.pointerType === "mouse" || e.pointerType === "pen") {
        track(surfaceAt(e.target), e.clientX, e.clientY);
      }
    },
    { passive: true },
  );
  const finishPointer = (e) => {
    if (pressed?.id === e.pointerId) {
      pressed = null;
      if (!touch) fade();
    }
  };
  document.addEventListener("pointerup", finishPointer, { passive: true });
  document.addEventListener("pointercancel", finishPointer, { passive: true });
  document.addEventListener(
    "pointerout",
    (e) => {
      if (!pressed && !touch && surface && !surface.contains(e.relatedTarget))
        fade();
    },
    { passive: true },
  );
  // Passive touch tracking keeps lighting alive when a scrolling sidebar causes
  // pointercancel. This path never cancels native scrolling or commits a route.
  document.addEventListener(
    "touchstart",
    (e) => {
      if (touch || !e.changedTouches.length) return;
      const node = surfaceAt(e.target);
      if (!node) return;
      const t = e.changedTouches[0];
      touch = { id: t.identifier, node };
      track(node, t.clientX, t.clientY);
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!touch) return;
      const t = [...e.touches].find((t) => t.identifier === touch.id);
      if (t) track(touch.node, t.clientX, t.clientY);
    },
    { passive: true },
  );
  const finishTouch = (e) => {
    if (touch && [...e.changedTouches].some((t) => t.identifier === touch.id)) {
      touch = null;
      pressed = null;
      fade();
    }
  };
  document.addEventListener("touchend", finishTouch, { passive: true });
  document.addEventListener("touchcancel", finishTouch, { passive: true });
  const reset = () => {
    pressed = touch = null;
    fade();
  };
  document.addEventListener(
    "scroll",
    () => {
      if (point && !frame) frame = requestAnimationFrame(paint);
    },
    { passive: true, capture: true },
  );
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) reset();
  });
  return reset;
}

export function installNavigation() {
  const resetLight = installMaterialLight();
  let gesture = null,
    suppressClickUntil = 0,
    internalClick = false;
  const showCandidate = (button) => {
    if (!gesture) return;
    buttonList(gesture.nav).forEach((item) =>
      item.toggleAttribute("data-candidate", item === button),
    );
    gesture.nav.toggleAttribute("data-scrubbing", true);
  };
  const clear = () => {
    const old = gesture;
    gesture = null;
    if (old) {
      old.nav.removeAttribute("data-scrubbing");
      buttonList(old.nav).forEach((button) =>
        button.removeAttribute("data-candidate"),
      );
      try {
        if (old.pointer && old.nav.hasPointerCapture(old.id))
          old.nav.releasePointerCapture(old.id);
      } catch {
        /* detached surface */
      }
    }
    return old;
  };
  const cancel = () => {
    if (gesture) {
      clear();
      suppressClickUntil = performance.now() + 900;
    }
    resetLight();
  };
  const start = (nav, id, x, y, pointer) => {
    if (!nav || nav.closest("[inert]")) return false;
    gesture = { nav, id, pointer };
    showCandidate(hitNavigation(nav, x, y));
    return true;
  };
  const commit = (x, y) => {
    if (!gesture) return;
    // Re-hit at release, even when the final location had no preceding move.
    const target = hitNavigation(gesture.nav, x, y);
    clear();
    suppressClickUntil = performance.now() + 900;
    resetLight();
    if (!target || target.getAttribute("aria-current") === "page") return;
    // The normal application action handler still owns routing/dirty guards.
    // Keep click suppression outside the replaceable navigation DOM.
    internalClick = true;
    try {
      target.click();
    } finally {
      internalClick = false;
    }
  };
  document.addEventListener(
    "click",
    (e) => {
      if (internalClick) return;
      const pointerClick =
        e.detail > 0 ||
        !!e.pointerType ||
        e.sourceCapabilities?.firesTouchEvents;
      if (pointerClick && performance.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const button = e.target.closest?.(`${BAR} > button`);
      if (button?.getAttribute("aria-current") === "page") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  if (window.PointerEvent) {
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (gesture) return; // including secondary fingers and another mouse
        suppressClickUntil = 0; // a genuine new interaction is not a ghost click
        if (e.isPrimary === false || e.button !== 0) return;
        const nav = e.target.closest?.(BAR);
        if (!start(nav, e.pointerId, e.clientX, e.clientY, true)) return;
        e.preventDefault();
        try {
          nav.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic/older hosts still use document tracking */
        }
      },
      { passive: false },
    );
    document.addEventListener(
      "pointermove",
      (e) => {
        if (gesture?.id !== e.pointerId) return;
        if (!gesture.nav.isConnected) {
          cancel();
          return;
        }
        e.preventDefault();
        showCandidate(hitNavigation(gesture.nav, e.clientX, e.clientY));
      },
      { passive: false },
    );
    document.addEventListener(
      "pointerup",
      (e) => {
        if (gesture?.id !== e.pointerId) return;
        e.preventDefault();
        commit(e.clientX, e.clientY);
      },
      { passive: false },
    );
    document.addEventListener("pointercancel", (e) => {
      if (gesture?.id === e.pointerId) cancel();
    });
    document.addEventListener("lostpointercapture", (e) => {
      if (gesture?.id === e.pointerId) cancel();
    });
  } else {
    // Only a bar-started touch is cancelled. Content/sidebars retain pan-y.
    document.addEventListener(
      "touchstart",
      (e) => {
        if (gesture) return;
        suppressClickUntil = 0;
        const nav = e.target.closest?.(BAR),
          t = e.changedTouches[0];
        if (t && start(nav, t.identifier, t.clientX, t.clientY, false))
          e.preventDefault();
      },
      { passive: false },
    );
    document.addEventListener(
      "touchmove",
      (e) => {
        if (!gesture) return;
        const t = [...e.changedTouches].find(
          (t) => t.identifier === gesture.id,
        );
        if (!t) return;
        e.preventDefault();
        showCandidate(hitNavigation(gesture.nav, t.clientX, t.clientY));
      },
      { passive: false },
    );
    document.addEventListener(
      "touchend",
      (e) => {
        if (!gesture) return;
        const t = [...e.changedTouches].find(
          (t) => t.identifier === gesture.id,
        );
        if (!t) return;
        e.preventDefault();
        commit(t.clientX, t.clientY);
      },
      { passive: false },
    );
    document.addEventListener("touchcancel", (e) => {
      if (
        gesture &&
        [...e.changedTouches].some((t) => t.identifier === gesture.id)
      )
        cancel();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (gesture) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      cancel();
      return;
    }
    const nav = e.target.closest?.(BAR);
    if (
      !nav ||
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(e.key)
    )
      return;
    const buttons = buttonList(nav).filter((b) => !b.disabled);
    if (!buttons.length) return;
    e.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const target =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : (index +
              (["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1) +
              buttons.length) %
            buttons.length;
    buttons[target].focus(); // Enter/Space remains the button's native activation
  });
  window.addEventListener("blur", cancel);
  window.addEventListener("resize", cancel);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancel();
  });
  return { cancel, isInteracting: () => Boolean(gesture) };
}
