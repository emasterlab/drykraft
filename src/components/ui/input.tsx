import * as React from "react"
import { Eye, EyeOff } from "lucide-react"
import { cn } from "@/lib/utils"

type InputProps = React.ComponentProps<"input"> & { visibilityLabel?: string }

function Input({ className, type, visibilityLabel = "password", id, ref, ...props }: InputProps) {
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  const [visible, setVisible] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  React.useEffect(() => {
    const form = inputRef.current?.form
    const hide = () => setVisible(false)
    form?.addEventListener("reset", hide)
    return () => form?.removeEventListener("reset", hide)
  }, [])
  const password = type === "password"
  const input = (
    <input
      id={inputId}
      type={password && visible ? "text" : type}
      ref={node => {
        inputRef.current = node
        if (typeof ref === "function") return ref(node)
        if (ref) ref.current = node
      }}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
  if (!password) return input
  return <span className="password-input">
    {input}
    <button
      type="button"
      className="password-visibility"
      aria-label={`${visible ? "Hide" : "Show"} ${visibilityLabel}`}
      aria-controls={inputId}
      aria-pressed={visible}
      title={`${visible ? "Hide" : "Show"} ${visibilityLabel}`}
      disabled={props.disabled}
      onClick={() => setVisible(value => !value)}
    >
      {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
    </button>
  </span>
}

function PasswordField({ label, children, fieldClassName, id, ...props }: Omit<InputProps, "type"> & {
  label: React.ReactNode
  children?: React.ReactNode
  fieldClassName?: string
}) {
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  return <div className={cn("password-field", fieldClassName)}>
    <label htmlFor={inputId}>{label}</label>
    <Input {...props} id={inputId} type="password" visibilityLabel={typeof label === "string" ? label.toLowerCase() : "password"} />
    {children}
  </div>
}

export { Input, PasswordField }
