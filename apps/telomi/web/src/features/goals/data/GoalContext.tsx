import { createContext } from "react";

export const GoalContext = createContext<{ goalId: string } | null>(null);
