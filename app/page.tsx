'use type';
'use client';

import React, { useState, useEffect } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getDatabase, ref, onValue, set, push, update, remove } from 'firebase/database';

export default function QueueApp() {
  const [db, setDb] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState('');
  
  const [view, setView] = useState('select');
  const [subjectId, setSubjectId] = useState('history');
  
  const [teacherPin, setTeacherPin] = useState('');
  const [current, setCurrent] = useState<any>(null);
  const [queueList, setQueueList] = useState<any[]>([]);
  const [timer, setTimer] = useState(300);
  const [isTimerRunning, setIsTimerRunning] = useState(false);

  const [parentName, setParentName] = useState('');
  const [myId, setMyId] = useState<string | null>(null);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [isSoonTurn, setIsSoonTurn] = useState(false);

  useEffect(() => {
    try {
      const firebaseConfig = {
        apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        databaseURL: "https://parent-teacher-meeting-543fc-default-rtdb.europe-west1.firebasedatabase.app",
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
      };

      const app = !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];
      const database = getDatabase(app);
      setDb(database);
    } catch (err: any) {
      setErrorMsg('Ошибка инициализации базы данных.');
    }
  }, []);

  useEffect(() => {
    if (!db) return;
    const queueRef = ref(db, `queues/${subjectId}`);
    const unsubscribe = onValue(queueRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setCurrent(data.current || null);
        const listObj = data.list || {};
        const listArray = Object.keys(listObj).map((key) => ({
          id: key,
          ...listObj[key],
        }));
        listArray.sort((a, b) => a.joinedAt - b.joinedAt);
        setQueueList(listArray);

        if (data.timer) {
          setTimer(data.timer.timeLeft ?? 300);
          setIsTimerRunning(data.timer.isRunning ?? false);
        }
      } else {
        setCurrent(null);
        setQueueList([]);
      }
    });

    return () => unsubscribe();
  }, [db, subjectId]);

  useEffect(() => {
    let interval: any = null;
    if (db && isTimerRunning && timer > 0) {
      interval = setInterval(() => {
        setTimer((prev) => {
          const nextTime = prev - 1;
          update(ref(db, `queues/${subjectId}/timer`), { timeLeft: nextTime });
          if (nextTime === 0) {
            setIsTimerRunning(false);
            update(ref(db, `queues/${subjectId}/timer`), { isRunning: false });
            try {
              const audio = new Audio('/bell.mp3');
              audio.play();
            } catch (e) {}
          }
          return nextTime;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [db, isTimerRunning, timer, subjectId]);

  const myIndex = queueList.findIndex((item) => item.id === myId);
  const peopleAhead = myIndex !== -1 ? myIndex : 0;

  useEffect(() => {
    if (myId && current && current.id === myId) {
      setIsMyTurn(true);
      setIsSoonTurn(false);
      try {
        const audio = new Audio('/notification.mp3');
        audio.play();
      } catch (e) {}
    } else {
      setIsMyTurn(false);
      if (myId && peopleAhead === 1) {
        setIsSoonTurn(true);
      } else {
        setIsSoonTurn(false);
      }
    }
  }, [current, myId, peopleAhead]);

  if (errorMsg) {
    return (
      <div className="min-h-screen bg-red-50 flex items-center justify-center p-4">
        <div className="bg-white p-6 rounded-2xl shadow-xl text-center max-w-md">
          <h2 className="text-xl font-bold text-red-600 mb-2">Ошибка</h2>
          <p className="text-gray-700">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (view === 'select') {
    return (
      <div className="min-h-screen bg-[#1e3a8a] flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-3xl shadow-2xl max-w-md w-full text-center space-y-6">
          <h1 className="text-2xl font-black text-[#1e3a8a]">Электронная очередь</h1>
          <p className="text-gray-500 text-sm">Школьное родительское собрание</p>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2 text-left">Выберите предмет:</label>
              <select 
                value={subjectId} 
                onChange={(e) => setSubjectId(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-xl font-semibold text-gray-800 focus:ring-2 focus:ring-[#1e3a8a]"
              >
                <option value="history">История Казахстана</option>
                <option value="math">Алгебра</option>
                <option value="physics">Физика</option>
                <option value="informatics">Информатика</option>
              </select>
            </div>

            <button
              onClick={() => setView('teacher_login')}
              className="w-full bg-[#1e3a8a] hover:bg-blue-900 text-white font-bold py-4 rounded-xl text-lg shadow-lg transition"
            >
              Я — Учитель 👨‍🏫
            </button>

            <button
              onClick={() => setView('parent')}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-xl text-lg shadow-lg transition"
            >
              Я — Родитель 📱
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'teacher_login') {
    return (
      <div className="min-h-screen bg-[#1e3a8a] flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-3xl shadow-2xl max-w-md w-full text-center space-y-6">
          <h2 className="text-2xl font-bold text-[#1e3a8a]">Вход для учителя</h2>
          <p className="text-gray-500 text-sm">Введите ваш PIN-код для доступа к управлению</p>
          
          <input
            type="password"
            placeholder="PIN-код"
            value={teacherPin}
            onChange={(e) => setTeacherPin(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-xl text-center text-xl tracking-widest focus:ring-2 focus:ring-[#1e3a8a]"
            autoFocus
          />

          <div className="flex gap-3">
            <button
              onClick={() => setView('select')}
              className="w-1/2 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-3 rounded-xl transition"
            >
              Назад
            </button>
            <button
              onClick={() => {
                if (teacherPin === '2026') {
                  setView('teacher');
                } else {
                  alert('Неверный PIN-код!');
                }
              }}
              className="w-1/2 bg-[#1e3a8a] hover:bg-blue-900 text-white font-bold py-3 rounded-xl transition"
            >
              Войти
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'teacher') {
    const isTimeOut = timer === 0;
    return (
      <div className={`min-h-screen p-6 transition-colors duration-500 ${isTimeOut ? 'bg-red-600 animate-pulse' : 'bg-gray-100'}`}>
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="bg-[#1e3a8a] text-white p-6 rounded-2xl shadow-lg flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-black">Кабинет учителя ({subjectId.toUpperCase()})</h1>
              <p className="text-blue-200 text-xs">Панель управления очередью</p>
            </div>
            <button 
              onClick={() => { setView('select'); setTeacherPin(''); }}
              className="bg-red-500 hover:bg-red-600 px-4 py-2 rounded-xl text-sm font-bold transition"
            >
              Выйти
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white p-6 rounded-2xl shadow-xl flex flex-col justify-between border-l-8 border-[#1e3a8a]">
              <div>
                <span className="text-gray-400 font-bold text-xs uppercase">Текущий посетитель</span>
                <div className="text-3xl font-black text-[#1e3a8a] mt-3">
                  {current ? current.name : "Свободно"}
                </div>
              </div>
              <button
                onClick={async () => {
                  if (queueList.length === 0) {
                    await set(ref(db, `queues/${subjectId}/current`), null);
                    return;
                  }
                  const nextUser = queueList[0];
                  await remove(ref(db, `queues/${subjectId}/list/${nextUser.id}`));
                  await set(ref(db, `queues/${subjectId}/current`), nextUser);
                  setTimer(300);
                  setIsTimerRunning(false);
                  update(ref(db, `queues/${subjectId}/timer`), { timeLeft: 300, isRunning: false });
                }}
                className="mt-6 w-full bg-green-600 hover:bg-green-700 text-white font-black py-4 rounded-xl text-xl shadow transition"
              >
                Пригласить следующего ➡️
              </button>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-xl flex flex-col justify-between">
              <div>
                <span className="text-gray-400 font-bold text-xs uppercase">Таймер (5 минут)</span>
                <div className={`text-5xl font-black text-center my-4 ${isTimeOut ? 'text-red-600' : 'text-gray-800'}`}>
                  {String(Math.floor(timer / 60)).padStart(2, '0')}:{String(timer % 60).padStart(2, '0')}
                </div>
              </div>
              <div className="flex gap-2">
                {!isTimerRunning ? (
                  <button
                    onClick={() => {
                      setIsTimerRunning(true);
                      update(ref(db, `queues/${subjectId}/timer`), { isRunning: true });
                    }}
                    className="flex-1 bg-[#1e3a8a] text-white font-bold py-3 rounded-xl transition"
                  >
                    Старт
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setIsTimerRunning(false);
                      update(ref(db, `queues/${subjectId}/timer`), { isRunning: false });
                    }}
                    className="flex-1 bg-yellow-500 text-white font-bold py-3 rounded-xl transition"
                  >
                    Пауза
                  </button>
                )}
                <button
                  onClick={() => {
                    setTimer(300);
                    setIsTimerRunning(false);
                    update(ref(db, `queues/${subjectId}/timer`), { timeLeft: 300, isRunning: false });
                  }}
                  className="bg-gray-200 text-gray-700 font-bold px-4 py-3 rounded-xl transition"
                >
                  Сброс
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-xl">
            <h3 className="text-lg font-bold text-gray-800 mb-3">Очередь ожидания ({queueList.length})</h3>
            {queueList.length === 0 ? (
              <p className="text-gray-400 text-center py-4">Очередь пуста</p>
            ) : (
              <div className="space-y-2">
                {queueList.map((item, index) => (
                  <div key={item.id} className="flex justify-between items-center p-3 bg-gray-50 rounded-xl">
                    <span className="font-bold text-gray-800">{index + 1}. {item.name}</span>
                    <span className="text-xs text-gray-500">
                      {new Date(item.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const estimatedTime = peopleAhead * 5;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-start p-4">
      <div className="max-w-md w-full space-y-6 pt-4">
        <div className="bg-[#1e3a8a] text-white p-6 rounded-2xl shadow-lg text-center flex justify-between items-center">
          <div>
            <h1 className="text-xl font-black">Электронная очередь</h1>
            <p className="text-blue-200 text-xs mt-1">Предмет: {subjectId.toUpperCase()}</p>
          </div>
          <button 
            onClick={() => { setView('select'); setMyId(null); }}
            className="bg-white/20 hover:bg-white/30 text-white px-3 py-1 rounded-lg text-xs font-bold transition"
          >
            Сменить предмет
          </button>
        </div>

        {isSoonTurn && (
          <div className="bg-yellow-500 text-white p-5 rounded-2xl shadow-xl text-center">
            <h2 className="text-xl font-black">СКОРО ВАША ОЧЕРЕДЬ!</h2>
            <p className="text-xs mt-1">Приготовьтесь, перед вами остался всего 1 человек</p>
          </div>
        )}

        {isMyTurn && (
          <div className="bg-green-500 text-white p-6 rounded-2xl shadow-2xl text-center animate-bounce">
            <h2 className="text-2xl font-black">ВАША ОЧЕРЕДЬ!</h2>
            <p className="text-sm mt-1">Пройдите в кабинет к учителю</p>
          </div>
        )}

        {!myId ? (
          <div className="bg-white p-6 rounded-2xl shadow-xl">
            <h2 className="text-lg font-bold text-gray-800 mb-4">Встать в очередь</h2>
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!parentName.trim()) return;
              const newListRef = ref(db, `queues/${subjectId}/list`);
              const newEntry = await push(newListRef, {
                name: parentName.trim(),
                joinedAt: Date.now(),
              });
              setMyId(newEntry.key);
            }} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">ФИО Ученика / Родителя</label>
                <input
                  type="text"
                  placeholder="Например: Алихан Султанов"
                  value={parentName}
                  onChange={(e) => setParentName(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-[#1e3a8a]"
                  required
                />
              </div>
              <button
                type="submit"
                className="w-full bg-[#1e3a8a] hover:bg-blue-900 text-white font-bold py-4 rounded-xl text-lg shadow transition"
              >
                Встать в очередь
              </button>
            </form>
          </div>
        ) : (
          <div className="bg-white p-6 rounded-2xl shadow-xl space-y-6 text-center">
            <div>
              <span className="text-gray-400 font-bold text-xs uppercase">Ваше имя</span>
              <div className="text-xl font-bold text-gray-800 mt-1">{parentName}</div>
            </div>

            {current && current.id === myId ? (
              <div className="bg-green-50 border-2 border-green-500 p-4 rounded-xl">
                <span className="text-green-600 font-bold text-lg">Вы сейчас на приеме у учителя!</span>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
                  <span className="text-xs text-gray-500 block">Перед вами</span>
                  <span className="text-3xl font-black text-[#1e3a8a]">{peopleAhead}</span>
                </div>
                <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
                  <span className="text-xs text-gray-500 block">Ожидание</span>
                  <span className="text-3xl font-black text-[#1e3a8a]">~{estimatedTime} мин</span>
                </div>
              </div>
            )}

            <button
              onClick={() => setMyId(null)}
              className="text-red-500 hover:underline text-sm font-semibold"
            >
              Выйти из очереди
            </button>
          </div>
        )}
      </div>
    </div>
  );
}