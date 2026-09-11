/**
 * 外壳共享基础控件的替身。
 *
 * 浏览器产物是从外壳那张冻结的模块表里取这些控件的，因此在 Node 测试里它们只需要
 * 表现得像被替换掉的控件即可。已发布包的 Node 半边会通过未声明的导入去够它整套
 * markdown 与高亮栈——使用者没有理由为了渲染一个表单而安装那一堆东西。
 */

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/** 外壳 `Button` 的最小替身。 */
export function Button({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string
  size?: string
  icon?: ReactNode
}): ReactNode {
  return <button type="button" {...rest}>{children}</button>
}

/** 外壳 `Input` 的最小替身；input 属性原样透传。 */
export function Input({ icon: _icon, ...rest }: InputHTMLAttributes<HTMLInputElement> & {
  icon?: ReactNode
}): ReactNode {
  return <input {...rest} />
}

/** 外壳 `Pill` 的最小替身。 */
export function Pill({ children, active: _active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
}): ReactNode {
  return <button type="button" {...rest}>{children}</button>
}

/** 外壳 `Switch` 的最小替身。 */
export function Switch({ checked, onChange, label, disabled, title }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => { onChange(!checked) }}
    />
  )
}
