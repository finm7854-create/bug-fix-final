import React, { useState, useEffect, useRef } from 'react';
import { Bug, UserProfile } from './types';
import { 
  subscribeToAuth, 
  subscribeToBugs, 
  createBug, 
  markBugSolvedInDb, 
  reopenBugInDb,
  deleteBugInDb, 
  deleteBugVideoInDb,
  seedSampleBugsIfEmpty,
  signInWithGoogle
} from './lib/firebase';
import { Header } from './components/Header';
import { StatCards } from './components/StatCards';
import { BugCard } from './components/BugCard';
import { BugDetailView } from './components/BugDetailView';
import { MarkSolvedModal } from './components/MarkSolvedModal';
import { AddBugModal } from './components/AddBugModal';
import { SolvedLogView } from './components/SolvedLogView';
import { ControlMenuModal } from './components/ControlMenuModal';
import { AdminUnlockModal } from './components/AdminUnlockModal';
import { BottomNav } from './components/BottomNav';
import { NotificationToast, NotificationSettingsModal } from './components/NotificationComponents';
import { useNotifications } from './context/NotificationContext';
import { ShieldAlert, Bug as BugIcon } from 'lucide-react';

const DELETED_BUG_IDS_KEY = 'bugboard_deleted_bugs_v1';
const DELETED_VIDEO_IDS_KEY = 'bugboard_deleted_videos_v1';

function getDeletedBugIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_BUG_IDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
    }
  } catch (e) {
    console.warn('Failed to load deleted bug IDs:', e);
  }
  return new Set();
}

function addDeletedBugId(id: string) {
  try {
    const set = getDeletedBugIds();
    set.add(id);
    localStorage.setItem(DELETED_BUG_IDS_KEY, JSON.stringify(Array.from(set)));
  } catch (e) {
    console.warn('Failed to save deleted bug ID:', e);
  }
}

function getDeletedVideoIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_VIDEO_IDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
    }
  } catch (e) {
    console.warn('Failed to load deleted video IDs:', e);
  }
  return new Set();
}

function addDeletedVideoId(id: string) {
  try {
    const set = getDeletedVideoIds();
    set.add(id);
    localStorage.setItem(DELETED_VIDEO_IDS_KEY, JSON.stringify(Array.from(set)));
  } catch (e) {
    console.warn('Failed to save deleted video ID:', e);
  }
}

function filterRemoteBugs(remoteBugs: Bug[]): Bug[] {
  const deletedBugs = getDeletedBugIds();
  const deletedVideos = getDeletedVideoIds();

  return remoteBugs
    .filter((b) => !deletedBugs.has(b.id))
    .map((b) => {
      const isVideoDeleted = deletedVideos.has(b.id);
      return {
        ...b,
        videoUrl: isVideoDeleted ? '' : b.videoUrl,
        videoDriveId: isVideoDeleted ? '' : b.videoDriveId,
      };
    });
}

export default function App() {
  const { addNotification } = useNotifications();
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [bugs, setBugs] = useState<Bug[]>([]);
  const [loading, setLoading] = useState(true);

  // Clear legacy bloated localStorage data to prevent QuotaExceededError
  useEffect(() => {
    try {
      localStorage.removeItem('bugboard_bugs_v2');
    } catch (e) {
      // Ignore
    }
  }, []);

  // View state
  const [currentTab, setCurrentTab] = useState<'board' | 'solved'>('board');
  const [activeFilter, setActiveFilter] = useState<'all' | 'open' | 'solved'>('open');
  const [selectedBug, setSelectedBug] = useState<Bug | null>(null);

  // Modals state
  const [showAddModal, setShowAddModal] = useState(false);
  const [showControlMenu, setShowControlMenu] = useState(false);
  const [markSolvedBug, setMarkSolvedBug] = useState<Bug | null>(null);
  const [showSignInPrompt, setShowSignInPrompt] = useState(false);
  const [showMemberRestrictionPrompt, setShowMemberRestrictionPrompt] = useState(false);
  const [isMarkingSubmitting, setIsMarkingSubmitting] = useState(false);
  const [firestoreError, setFirestoreError] = useState<string | null>(null);

  // Admin Access PIN (59205920) state
  const [isAdminUnlocked, setIsAdminUnlocked] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bugboard_admin_unlocked_v1') === 'true';
    } catch {
      return false;
    }
  });
  const [showAdminUnlockModal, setShowAdminUnlockModal] = useState(false);
  const [adminUnlockPurpose, setAdminUnlockPurpose] = useState('');
  const [pendingAdminAction, setPendingAdminAction] = useState<(() => void) | null>(null);

  const handleUnlockAdminSuccess = () => {
    setIsAdminUnlocked(true);
    try {
      localStorage.setItem('bugboard_admin_unlocked_v1', 'true');
    } catch (e) {}
    setShowAdminUnlockModal(false);
    if (pendingAdminAction) {
      pendingAdminAction();
      setPendingAdminAction(null);
    }
  };

  const handleLockAdmin = () => {
    setIsAdminUnlocked(false);
    try {
      localStorage.removeItem('bugboard_admin_unlocked_v1');
    } catch (e) {}
  };

  // 1. Auth Subscription
  useEffect(() => {
    const unsubscribeAuth = subscribeToAuth((user) => {
      setCurrentUser(user);
    });
    return () => unsubscribeAuth();
  }, []);

  // 2. Realtime Bugs Firestore Subscription
  const initialBugsLoadedRef = useRef(false);
  const prevBugsRef = useRef<Bug[]>([]);

  useEffect(() => {
    const safetyTimer = setTimeout(() => {
      setLoading(false);
    }, 2500);

    const unsubscribeBugs = subscribeToBugs(
      (remoteBugs) => {
        clearTimeout(safetyTimer);
        const processed = filterRemoteBugs(remoteBugs);

        if (initialBugsLoadedRef.current) {
          processed.forEach((b) => {
            const oldBug = prevBugsRef.current.find((prev) => prev.id === b.id);
            if (!oldBug) {
              // New remote bug created
              addNotification({
                type: 'new_bug',
                title: 'New Issue Submitted',
                message: `"${b.title}" was created by ${b.createdBy}`,
                bugId: b.id,
                bugTitle: b.title,
                authorName: b.createdBy
              });
            } else if (oldBug.status === 'open' && b.status === 'solved') {
              // Remote bug marked solved
              addNotification({
                type: 'solved_bug',
                title: 'Issue Solved',
                message: `"${b.title}" was marked solved by ${b.solvedBy || 'a team member'}`,
                bugId: b.id,
                bugTitle: b.title
              });
            }
          });
        } else {
          initialBugsLoadedRef.current = true;
        }

        prevBugsRef.current = processed;
        setBugs(processed);
        setLoading(false);
        setFirestoreError(null);
      },
      (errInfo) => {
        clearTimeout(safetyTimer);
        console.warn('Realtime bugs listener error:', errInfo);
        setLoading(false);
        if (errInfo?.error) {
          setFirestoreError(errInfo.error);
        }
      }
    );

    return () => {
      clearTimeout(safetyTimer);
      unsubscribeBugs();
    };
  }, []);

  // Sync selected bug if bugs list changes
  useEffect(() => {
    if (selectedBug) {
      const refreshed = bugs.find((b) => b.id === selectedBug.id);
      if (refreshed) setSelectedBug(refreshed);
    }
  }, [bugs]);

  // Handle Add Bug button click
  const handleAddBugClick = () => {
    if (!isAdminUnlocked) {
      setAdminUnlockPurpose('To submit new bug reports, enter the Admin Code');
      setPendingAdminAction(() => () => setShowAddModal(true));
      setShowAdminUnlockModal(true);
    } else {
      setShowAddModal(true);
    }
  };

  // Trigger Mark Solved Modal (checking Admin PIN first)
  const handleOpenMarkSolved = (bug: Bug) => {
    if (!isAdminUnlocked) {
      setAdminUnlockPurpose('To mark bugs as solved, enter the Admin Code');
      setPendingAdminAction(() => () => setMarkSolvedBug(bug));
      setShowAdminUnlockModal(true);
    } else {
      setMarkSolvedBug(bug);
    }
  };

  // Handle Mark Solved
  const handleConfirmMarkSolved = async (solverName: string) => {
    if (!markSolvedBug) return;
    setIsMarkingSubmitting(true);
    
    const targetId = markSolvedBug.id;
    const solvedTime = new Date().toISOString();
    const finalSolver = solverName.trim() || 'Anonymous Friend';

    // Clear heavy media assets upon solving to preserve storage space while keeping text log
    setBugs((prev) =>
      prev.map((b) =>
        b.id === targetId
          ? {
              ...b,
              status: 'solved' as const,
              solvedBy: finalSolver,
              solvedAt: solvedTime,
              imageUrls: [],
              videoUrls: [],
              audioUrls: [],
              photoUrl: '',
              videoUrl: '',
              photoDriveId: '',
              videoDriveId: ''
            }
          : b
      )
    );

    if (selectedBug?.id === targetId) {
      setSelectedBug((prev) =>
        prev
          ? {
              ...prev,
              status: 'solved' as const,
              solvedBy: finalSolver,
              solvedAt: solvedTime,
              imageUrls: [],
              videoUrls: [],
              audioUrls: [],
              photoUrl: '',
              videoUrl: '',
              photoDriveId: '',
              videoDriveId: ''
            }
          : null
      );
    }
    setMarkSolvedBug(null);

    try {
      await markBugSolvedInDb(targetId, finalSolver);
      addNotification({
        type: 'solved_bug',
        title: 'Issue Solved',
        message: `"${markSolvedBug.title}" was marked solved by ${finalSolver}`,
        bugId: targetId,
        bugTitle: markSolvedBug.title
      });
    } catch (err) {
      console.warn('Notice: Remote update failed:', err);
      setFirestoreError('Failed to mark bug as solved in Firestore.');
    } finally {
      setIsMarkingSubmitting(false);
    }
  };

  // Handle Create Bug Submission
  const handleCreateBug = async (newBugData: Omit<Bug, 'id' | 'status' | 'createdAt'>) => {
    const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const fullBugData: Omit<Bug, 'id'> = {
      ...newBugData,
      status: 'open',
      createdBy: currentUser?.displayName || currentUser?.email || 'Board Owner',
      createdByEmail: currentUser?.email || undefined,
      createdAt: new Date().toISOString()
    };

    const tempBug: Bug = {
      ...fullBugData,
      id: tempId
    };

    // Optimistically show immediately on UI so user sees the new entry instantly
    setBugs((prev) => [tempBug, ...prev.filter((b) => b.id !== tempId)]);

    try {
      const docId = await createBug(fullBugData);
      const finalBugId = docId || tempId;
      if (docId && docId !== tempId) {
        setBugs((prev) => prev.map((b) => (b.id === tempId ? { ...b, id: docId } : b)));
      }
      addNotification({
        type: 'new_bug',
        title: 'New Issue Created',
        message: `"${fullBugData.title}" was submitted by ${fullBugData.createdBy}`,
        bugId: finalBugId,
        bugTitle: fullBugData.title,
        authorName: fullBugData.createdBy
      });
    } catch (err: any) {
      console.error('Remote bug creation failed:', err);
      // Remove temp bug on failure
      setBugs((prev) => prev.filter((b) => b.id !== tempId));
      setFirestoreError(err?.message || 'Failed to save bug to Firestore.');
      throw err;
    }
  };

  // Handle Delete Bug
  const handleDeleteBug = async (bugId: string) => {
    addDeletedBugId(bugId);
    setBugs((prev) => prev.filter((b) => b.id !== bugId));
    if (selectedBug?.id === bugId) {
      setSelectedBug(null);
    }
    try {
      await deleteBugInDb(bugId);
    } catch (err) {
      console.warn('Failed to delete bug in DB:', err);
    }
  };

  // Handle Delete Bug Video
  const handleDeleteVideo = async (bugId: string) => {
    addDeletedVideoId(bugId);
    setBugs((prev) =>
      prev.map((b) =>
        b.id === bugId ? { ...b, videoUrl: '', videoDriveId: '' } : b
      )
    );
    if (selectedBug?.id === bugId) {
      setSelectedBug((prev) => (prev ? { ...prev, videoUrl: '', videoDriveId: '' } : null));
    }
    try {
      await deleteBugVideoInDb(bugId);
    } catch (err) {
      console.warn('Failed to delete bug video in DB:', err);
    }
  };

  // Handle Reopen Bug
  const handleReopenBug = async (bugId: string) => {
    setBugs((prev) =>
      prev.map((b) =>
        b.id === bugId
          ? { ...b, status: 'open' as const, solvedBy: '', solvedAt: '' }
          : b
      )
    );
    if (selectedBug?.id === bugId) {
      setSelectedBug((prev) =>
        prev ? { ...prev, status: 'open' as const, solvedBy: '', solvedAt: '' } : null
      );
    }
    try {
      await reopenBugInDb(bugId);
    } catch (err) {
      console.warn('Failed to reopen bug in DB:', err);
    }
  };

  // Filtered Bugs for Board view
  const filteredBugs = bugs.filter((bug) => {
    if (activeFilter === 'open') return bug.status === 'open';
    if (activeFilter === 'solved') return bug.status === 'solved';
    return true;
  });

  // If viewing bug detail
  if (selectedBug) {
    return (
      <>
        <BugDetailView
          bug={selectedBug}
          currentUser={currentUser}
          onBack={() => setSelectedBug(null)}
          onMarkSolvedClick={() => handleOpenMarkSolved(selectedBug)}
          onReopenBug={handleReopenBug}
          onDeleteBug={handleDeleteBug}
        />

        {/* Mark Solved Prompt Modal */}
        {markSolvedBug && (
          <MarkSolvedModal
            bugTitle={markSolvedBug.title}
            onClose={() => setMarkSolvedBug(null)}
            onConfirm={handleConfirmMarkSolved}
            isSubmitting={isMarkingSubmitting}
          />
        )}

        {/* Admin PIN Unlock Modal */}
        <AdminUnlockModal
          isOpen={showAdminUnlockModal}
          onClose={() => setShowAdminUnlockModal(false)}
          onSuccess={handleUnlockAdminSuccess}
          purposeMessage={adminUnlockPurpose}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen min-h-[100dvh] w-full bg-[#EAF3F4] text-[#1D252D] flex flex-col font-sans selection:bg-[#C37C75]/30">
      <div className="w-full flex flex-col flex-1 bg-[#EAF3F4]">
        {/* Top App Header */}
        <Header 
          user={currentUser} 
          bugs={bugs}
          isAdminUnlocked={isAdminUnlocked}
          onOpenAddModal={handleAddBugClick} 
          onOpenControlMenu={() => setShowControlMenu(true)}
          onOpenAdminUnlockModal={() => {
            setAdminUnlockPurpose('Enter code to unlock Admin submission & solve rights');
            setShowAdminUnlockModal(true);
          }}
          onLockAdmin={handleLockAdmin}
        />

        {/* Main Content Area */}
        <main className="flex-1 px-6 sm:px-8 pt-6 pb-32 w-full flex flex-col">
          {firestoreError && (
            <div className="mb-4 p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-center justify-between">
              <div>
                <span className="font-bold">Firestore Sync Status:</span> {firestoreError}
              </div>
              <button
                onClick={() => setFirestoreError(null)}
                className="ml-4 font-bold text-amber-700 hover:underline cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-28 text-center space-y-4">
              <div className="w-16 h-0.5 bg-gray-300 relative overflow-hidden rounded-full">
                <div className="absolute top-0 bottom-0 left-0 w-8 bg-[#1D252D] animate-[slide_1.5s_infinite_ease-in-out]" />
              </div>
              <p className="font-serif italic text-gray-500 font-bold text-xl">
                Fetching live dashboard data...
              </p>
            </div>
          ) : currentTab === 'solved' ? (
            /* Solved Log Tab View */
            <SolvedLogView bugs={bugs} onSelectBug={(bug) => setSelectedBug(bug)} />
          ) : (
            /* Board Tab View */
            <>
              {/* Top Section: Title and Stats */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <h2 className="text-2xl sm:text-3xl font-serif text-[#1D252D] italic tracking-wide font-medium">
                    {activeFilter === 'open' ? 'Active Issues' : activeFilter === 'solved' ? 'Solved Issues' : 'All Tickets'}
                  </h2>
                  <p className="text-sm text-gray-500 mt-1">
                    {activeFilter === 'open' ? 'Current active sprint issues and bugs.' : 'Resolved bugs and fixed issues.'}
                  </p>
                </div>

                <StatCards
                  bugs={bugs}
                  activeFilter={activeFilter}
                  onSelectFilter={setActiveFilter}
                />
              </div>

              {/* Divider */}
              <div className="my-5">
                <div className="h-px w-full bg-gray-200/90"></div>
              </div>

              {/* Bugs Grid */}
              {filteredBugs.length === 0 ? (
                <div className="bg-white/80 border border-gray-200/60 rounded-2xl p-10 text-center space-y-2 shadow-xs my-auto">
                  <p className="font-serif text-lg italic text-[#1D252D] font-medium">No bugs found in this view</p>
                  <p className="text-xs text-gray-500">
                    {activeFilter === 'open'
                      ? 'All clear! No open software bugs at the moment.'
                      : 'No bugs have been marked solved yet.'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
                  {filteredBugs.map((bug) => (
                    <BugCard
                      key={bug.id}
                      bug={bug}
                      onClick={() => setSelectedBug(bug)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Bottom Navigation & Action Bar */}
      <BottomNav
        currentTab={currentTab}
        onTabChange={(tab) => setCurrentTab(tab)}
        onAddClick={handleAddBugClick}
      />

      {/* Add Bug Modal */}
      {showAddModal && (
        <AddBugModal
          user={currentUser || { uid: 'guest', displayName: 'Guest User', role: 'Member' }}
          onClose={() => setShowAddModal(false)}
          onSubmit={handleCreateBug}
        />
      )}

      {/* Control Menu Panel Modal */}
      {showControlMenu && (
        <ControlMenuModal
          bugs={bugs}
          onClose={() => setShowControlMenu(false)}
          onDeleteVideo={handleDeleteVideo}
          onDeleteBug={handleDeleteBug}
          onReopenBug={handleReopenBug}
        />
      )}

      {/* Mark Solved Prompt Modal */}
      {markSolvedBug && (
        <MarkSolvedModal
          bugTitle={markSolvedBug.title}
          onClose={() => setMarkSolvedBug(null)}
          onConfirm={handleConfirmMarkSolved}
          isSubmitting={isMarkingSubmitting}
        />
      )}

      {/* Sign-In Required Banner / Dialog */}
      {showSignInPrompt && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-3xl p-6 w-full max-w-sm text-center shadow-2xl relative space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
              <BugIcon className="w-6 h-6 stroke-[2.5]" />
            </div>

            <div>
              <h3 className="text-lg font-bold text-slate-900">Sign-In Required</h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Sign in with Google to participate. The app owner receives the <strong>Admin</strong> role to add bugs. Friends sign in as <strong>Members</strong> to browse and mark bugs solved!
              </p>
            </div>

            <div className="space-y-2 pt-2">
              <button
                onClick={async () => {
                  setShowSignInPrompt(false);
                  try {
                    const res = await signInWithGoogle();
                    if (res.user?.role === 'Admin') {
                      setShowAddModal(true);
                    } else if (res.user) {
                      setShowMemberRestrictionPrompt(true);
                    }
                  } catch (err) {
                    console.error('Sign in error', err);
                  }
                }}
                className="w-full py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm transition-all active:scale-95 shadow-md shadow-indigo-200"
              >
                Sign in with Google
              </button>
              <button
                onClick={() => setShowSignInPrompt(false)}
                className="w-full py-2.5 rounded-2xl bg-slate-100 text-slate-700 hover:bg-slate-200 text-xs font-bold transition-colors"
              >
                Continue as Guest
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Member Role Restriction Dialog */}
      {showMemberRestrictionPrompt && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-3xl p-6 w-full max-w-sm text-center shadow-2xl relative space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto">
              <ShieldAlert className="w-6 h-6 stroke-[2.5]" />
            </div>

            <div>
              <h3 className="text-lg font-bold text-slate-900">Member Role</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                You are signed in as <span className="font-semibold text-slate-900">{currentUser?.displayName || currentUser?.email}</span> (<strong>Member</strong>).
              </p>
              <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                Members can view bugs and mark issues as solved. Creating new bug entries is reserved for the <strong>Admin</strong>.
              </p>
            </div>

            <button
              onClick={() => setShowMemberRestrictionPrompt(false)}
              className="w-full py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm transition-all active:scale-95 shadow-md shadow-indigo-200"
            >
              Understood
            </button>
          </div>
        </div>
      )}

      {/* Admin PIN Unlock Modal */}
      <AdminUnlockModal
        isOpen={showAdminUnlockModal}
        onClose={() => setShowAdminUnlockModal(false)}
        onSuccess={handleUnlockAdminSuccess}
        purposeMessage={adminUnlockPurpose}
      />

      {/* Global Toast Notifications & Settings Modal */}
      <NotificationToast
        onSelectBug={(bugId) => {
          const bug = bugs.find((b) => b.id === bugId);
          if (bug) setSelectedBug(bug);
        }}
      />
      <NotificationSettingsModal />
    </div>
  );
}
