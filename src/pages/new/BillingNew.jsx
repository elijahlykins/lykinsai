import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, CreditCard } from "lucide-react";

export default function BillingNew() {
  const nav = useNavigate();

  return (
    <div className="min-h-screen bg-transparent flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-white/40 border border-white/50 backdrop-blur-md flex items-center justify-center mx-auto">
          <CreditCard className="w-7 h-7 text-black/40" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-black/85">Billing</h1>
          <p className="mt-2 text-sm text-black/50">Coming soon</p>
        </div>
        <button
          type="button"
          onClick={() => nav(-1)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-white/50 bg-white/40 backdrop-blur-md text-sm font-medium text-black/70 hover:bg-white/60 transition-all"
        >
          <ArrowLeft className="w-4 h-4" />
          Go back
        </button>
      </div>
    </div>
  );
}
