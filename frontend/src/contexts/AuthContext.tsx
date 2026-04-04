"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { authApi, type Agent } from "@/lib/api";

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: { id: string; username: string } | null;
  agents: Agent[];
  selectedAgent: Agent | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  selectAgent: (agent: Agent) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string; username: string } | null>(
    null
  );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("ab_token");
    if (stored) {
      setToken(stored);
      authApi
        .me()
        .then((data) => {
          setUser(data.user);
          setAgents(data.agents ?? []);
          if (data.agents?.length) {
            const savedEns = localStorage.getItem("ab_selected_agent");
            const found = data.agents.find((a) => a.ens_name === savedEns);
            setSelectedAgent(found ?? data.agents[0]);
          }
        })
        .catch(() => {
          localStorage.removeItem("ab_token");
          setToken(null);
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const data = await authApi.login(username, password);
    localStorage.setItem("ab_token", data.token);
    setToken(data.token);
    setUser(data.user);
    // Fetch agents after login
    try {
      const me = await authApi.me();
      setAgents(me.agents ?? []);
      if (me.agents?.length) setSelectedAgent(me.agents[0]);
    } catch {
      /* ignore */
    }
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const data = await authApi.register(username, password);
    localStorage.setItem("ab_token", data.token);
    setToken(data.token);
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("ab_token");
    localStorage.removeItem("ab_selected_agent");
    setToken(null);
    setUser(null);
    setAgents([]);
    setSelectedAgent(null);
  }, []);

  const selectAgent = useCallback((agent: Agent) => {
    setSelectedAgent(agent);
    localStorage.setItem("ab_selected_agent", agent.ens_name);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: !!token,
        isLoading,
        user,
        agents,
        selectedAgent,
        token,
        login,
        register,
        logout,
        selectAgent,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
