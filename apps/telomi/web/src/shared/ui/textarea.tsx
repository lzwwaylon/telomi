import * as React from "react";
import { cn } from "@/shared/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
function Textarea({ className, ...props }, ref) {
	return (
		<textarea
			ref={ref}
			data-slot="textarea"
			className={cn(
				"border-input placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
				"focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px]",
				"aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
				className,
			)}
			{...props}
		/>
	);
});
Textarea.displayName = "Textarea";

export { Textarea };
