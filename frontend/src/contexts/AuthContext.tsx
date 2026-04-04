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

/** Resolved after login via GET /auth/me; null if /me failed (caller may fall back to PAT onboarding). */
export type PostAuthGithubFlags = { api_key_configured: boolean } | null;

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: { id: string; username: string } | null;
  agents: Agent[];
  selectedAgent: Agent | null;
  token: string | null;
  github: { api_key_configured: boolean } | null;
  login: (username: string, password: string) => Promise<PostAuthGithubFlags>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  selectAgent: (agent: Agent) => void;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string; username: string } | null>(
    null
  );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [github, setGithub] = useState<{ api_key_configured: boolean } | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    const stored = localStorage.getItem("ab_token");
    if (!stored) return;
    const data = await authApi.me();
    setToken(stored);
    setUser(data.user);
    setAgents(data.agents ?? []);
    setGithub(data.github ?? null);
    if (data.agents?.length) {
      const savedEns = localStorage.getItem("ab_selected_agent");
      const found = data.agents.find((a) => a.ens_name === savedEns);
      setSelectedAgent(found ?? data.agents[0]);
    } else {
      setSelectedAgent(null);
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("ab_token");
    if (stored) {
      authApi
        .me()
        .then((data) => {
          setToken(stored);
          setUser(data.user);
          setAgents(data.agents ?? []);
          setGithub(data.github ?? null);
          if (data.agents?.length) {
            const savedEns = localStorage.getItem("ab_selected_agent");
            const found = data.agents.find((a) => a.ens_name === savedEns);
            setSelectedAgent(found ?? data.agents[0]);
          }
        })
        .catch(() => {
          localStorage.removeItem("ab_token");
          setToken(null);
          setUser(null);
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
    try {
      const me = await authApi.me();
      setAgents(me.agents ?? []);
      setGithub(me.github ?? null);
      if (me.agents?.length) {
        const savedEns = localStorage.getItem("ab_selected_agent");
        const found = me.agents.find((a) => a.ens_name === savedEns);
        setSelectedAgent(found ?? me.agents[0]);
      } else {
        setSelectedAgent(null);
      }
      return me.github ?? { api_key_configured: false };
    } catch {
      return null;
    }
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const data = await authApi.register(username, password);
    localStorage.setItem("ab_token", data.token);
    setToken(data.token);
    setUser(data.user);
    try {
      const me = await authApi.me();
      setAgents(me.agents ?? []);
      setGithub(me.github ?? null);
      if (me.agents?.length) {
        const savedEns = localStorage.getItem("ab_selected_agent");
        const found = me.agents.find((a) => a.ens_name === savedEns);
        setSelectedAgent(found ?? me.agents[0]);
      } else {
        setSelectedAgent(null);
      }
    } catch {
      /* session hydrated on next /me */
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("ab_token");
    localStorage.removeItem("ab_selected_agent");
    setToken(null);
    setUser(null);
    setAgents([]);
    setSelectedAgent(null);
    setGithub(null);
  }, []);

  const selectAgent = useCallback((agent: Agent) => {
    setSelectedAgent(agent);
    localStorage.setItem("ab_selected_agent", agent.ens_name);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        // After hydrate, only true once /auth/me succeeded — avoids firing
        // repo list (Bearer) before the session is confirmed / parallel to /me.
        isAuthenticated: !!user,
        isLoading,
        user,
        agents,
        selectedAgent,
        token,
        github,
        login,
        register,
        logout,
        selectAgent,
        refreshSession,
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
