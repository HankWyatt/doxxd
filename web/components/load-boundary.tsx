"use client";
import { Component, type ReactNode } from "react";

/**
 * Shows `fallback` when a lazily loaded chunk fails to load (or throws while
 * rendering), so one failed download never takes the whole page down.
 */
export class LoadBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
