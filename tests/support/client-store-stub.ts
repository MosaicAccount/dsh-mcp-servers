/**
 * 外壳 `@deepseek-ai/dsh-client-store` 的最小替身。
 *
 * 真正的快照 store 由外壳的冻结模块表提供（zustand/immer 随外壳发行，本包既不声明
 * 也不携带它们），所以 Node 测试里那个包一旦被求值就会去够 `zustand` 而失败。
 * `src/client/store.ts` 只用到 `createSnapshotStore` 的 getSnapshot / subscribe /
 * update / set 四项能力，替身按同样的语义实现它们：更新走一份草稿对象，提交后替换
 * 快照引用并同步通知订阅者。
 */

/** 可写快照 store，形状与外壳契约一致。 */
export interface SnapshotStore<T extends object> {
  /** 读取当前快照（在下次变化前保持同一引用）。 */
  getSnapshot(): T
  /** 订阅快照替换。 */
  subscribe(listener: () => void): () => void
  /** 通过草稿修改快照。 */
  update(mutator: (draft: T) => void): void
  /** 整体替换快照。 */
  set(next: T): void
}

/**
 * 创建一份快照 store 替身。
 * @param init - 初始状态。
 * @returns 可读、可写、可订阅的 store。
 */
export function createSnapshotStore<T extends object>(init: T): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()

  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (mutator) => {
      const draft = Object.assign({}, state) as T
      mutator(draft)
      state = draft
      publish()
    },
    set: (next) => {
      state = next
      publish()
    },
  }
}
