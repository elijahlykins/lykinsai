import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Check, Crown, Zap, Brain, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';
import NotionSidebar from '../components/notes/NotionSidebar';
import SettingsModal from '../components/notes/SettingsModal';

export default function BillingPage() {
  const [user, setUser] = useState(null);
  const [currentPlan, setCurrentPlan] = useState('free');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const loadUser = async () => {
      try {
        const currentUser = await base44.auth.me();
        setUser(currentUser);
        // Check if user has a plan stored
        const plan = currentUser.plan || 'free';
        setCurrentPlan(plan);
      } catch (error) {
        console.error('Error loading user:', error);
      }
    };
    loadUser();
  }, []);

  const plans = [
    {
      id: 'free',
      name: 'Free',
      price: '$0',
      period: 'forever',
      description: 'Perfect for getting started',
      icon: Brain,
      features: [
        '50 notes per month',
        'Basic AI analysis',
        '5 AI searches per day',
        'Standard memory retention',
        'Basic mind maps',
      ],
      buttonText: 'Current Plan',
      buttonVariant: 'outline',
    },
    {
      id: 'pro',
      name: 'Pro',
      price: '$12',
      period: 'per month',
      description: 'For serious memory keepers',
      icon: Zap,
      popular: true,
      features: [
        'Unlimited notes',
        'Advanced AI analysis',
        'Unlimited AI searches',
        'Priority processing',
        'Advanced mind maps',
        'Custom AI models (GPT-4, Claude)',
        'Export & backup',
        'Priority support',
      ],
      buttonText: 'Upgrade to Pro',
      buttonVariant: 'default',
    },
    {
      id: 'premium',
      name: 'Premium',
      price: '$29',
      period: 'per month',
      description: 'Maximum power & features',
      icon: Crown,
      features: [
        'Everything in Pro',
        'Team collaboration (up to 5 members)',
        'API access',
        'Custom integrations',
        'Advanced analytics',
        'White-label options',
        'Dedicated account manager',
        '99.9% uptime SLA',
      ],
      buttonText: 'Upgrade to Premium',
      buttonVariant: 'default',
    },
  ];

  const handleUpgrade = (planId) => {
    if (planId === currentPlan) return;
    alert(`Upgrade to ${planId} - Payment integration coming soon!`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50/30 to-gray-100 dark:from-[#171515] dark:via-[#171515] dark:to-[#171515] flex overflow-hidden">
      <div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300`}>
        <NotionSidebar
          activeView="billing"
          onViewChange={(view) => navigate(createPageUrl(
            view === 'short_term' ? 'ShortTerm' : 
            view === 'long_term' ? 'LongTerm' : 
            view === 'tags' ? 'TagManagement' : 
            view === 'reminders' ? 'Reminders' : 
            view === 'trash' ? 'Trash' :
            'Create'
          ))}
          onOpenSearch={() => navigate(createPageUrl('AISearch'))}
          onOpenChat={() => navigate(createPageUrl('MemoryChat'))}
          onOpenSettings={() => setSettingsOpen(true)}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto p-8">
          {/* Header */}
          <div className="text-center mb-12">
            <div className="flex items-center justify-center gap-2 mb-4">
              <Sparkles className="w-8 h-8 text-black dark:text-white" />
              <h1 className="text-4xl font-bold text-black dark:text-white">Upgrade Your Memory</h1>
            </div>
            <p className="text-gray-600 dark:text-gray-400 text-lg">
              Unlock the full potential of AI-powered memory management
            </p>
          </div>

          {/* Current User Info */}
          {user && (
            <div className="mb-8 p-4 bg-white dark:bg-[#171515] rounded-xl border border-gray-200 dark:border-gray-700 max-w-md mx-auto">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Signed in as</p>
                  <p className="font-semibold text-black dark:text-white">{user.email}</p>
                </div>
                <div className="px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-sm font-medium">
                  {currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}
                </div>
              </div>
            </div>
          )}

          {/* Pricing Cards */}
          <div className="grid md:grid-cols-3 gap-8 mb-12">
            {plans.map((plan) => {
              const Icon = plan.icon;
              const isCurrentPlan = plan.id === currentPlan;
              
              return (
                <div
                  key={plan.id}
                  className={`relative bg-white dark:bg-[#171515] rounded-2xl border-2 p-8 transition-all hover:scale-105 ${
                    plan.popular 
                      ? 'border-black dark:border-white shadow-xl' 
                      : 'border-gray-200 dark:border-gray-700'
                  } ${isCurrentPlan ? 'ring-2 ring-blue-500' : ''}`}
                >
                  {plan.popular && (
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1 bg-black dark:bg-white text-white dark:text-black text-xs font-bold rounded-full">
                      MOST POPULAR
                    </div>
                  )}

                  <div className="flex items-center justify-between mb-4">
                    <Icon className="w-8 h-8 text-black dark:text-white" />
                    {isCurrentPlan && (
                      <div className="px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded text-xs font-medium">
                        Current
                      </div>
                    )}
                  </div>

                  <h3 className="text-2xl font-bold text-black dark:text-white mb-2">{plan.name}</h3>
                  <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">{plan.description}</p>

                  <div className="mb-6">
                    <span className="text-4xl font-bold text-black dark:text-white">{plan.price}</span>
                    <span className="text-gray-600 dark:text-gray-400 ml-2">/ {plan.period}</span>
                  </div>

                  <Button
                    onClick={() => handleUpgrade(plan.id)}
                    disabled={isCurrentPlan}
                    className={`w-full mb-6 ${
                      plan.popular
                        ? 'bg-black dark:bg-white text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90'
                        : 'bg-gray-100 dark:bg-[#1f1d1d] text-black dark:text-white hover:bg-gray-200 dark:hover:bg-[#2a2828] border border-gray-300 dark:border-gray-600'
                    }`}
                  >
                    {isCurrentPlan ? 'Current Plan' : plan.buttonText}
                  </Button>

                  <div className="space-y-3">
                    {plan.features.map((feature, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <Check className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                        <span className="text-sm text-gray-700 dark:text-gray-300">{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* FAQ Section */}
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl font-bold text-black dark:text-white mb-6 text-center">
              Frequently Asked Questions
            </h2>
            <div className="space-y-4">
              <div className="bg-white dark:bg-[#171515] rounded-xl p-6 border border-gray-200 dark:border-gray-700">
                <h3 className="font-semibold text-black dark:text-white mb-2">Can I cancel anytime?</h3>
                <p className="text-gray-600 dark:text-gray-400 text-sm">
                  Yes! You can cancel your subscription at any time. Your access will continue until the end of your billing period.
                </p>
              </div>
              <div className="bg-white dark:bg-[#171515] rounded-xl p-6 border border-gray-200 dark:border-gray-700">
                <h3 className="font-semibold text-black dark:text-white mb-2">What payment methods do you accept?</h3>
                <p className="text-gray-600 dark:text-gray-400 text-sm">
                  We accept all major credit cards, debit cards, and PayPal.
                </p>
              </div>
              <div className="bg-white dark:bg-[#171515] rounded-xl p-6 border border-gray-200 dark:border-gray-700">
                <h3 className="font-semibold text-black dark:text-white mb-2">Is my data secure?</h3>
                <p className="text-gray-600 dark:text-gray-400 text-sm">
                  Absolutely. We use enterprise-grade encryption and security measures to protect your memories and data.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}