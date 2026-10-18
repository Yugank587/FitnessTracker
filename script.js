
"use strict";

document.addEventListener("DOMContentLoaded", async function () {
  const $ = id => document.getElementById(id);

  
const SUPABASE_URL = "https://qlcbbgiylkqglutikrkh.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5Y-HrZKmk5fxHUV-n_FdAg_cjL1eTGs";

  const LEGACY_SESSION_KEY = "fitnessTrackerCurrentUser";

  let supabaseClient = null;
  let currentUser = null;
  let data = { steps: 0, water: 0, calories: 0, heartRate: null };
  let goals = { steps: 8000, water: 2000, calories: 500 };
  let history = {};
  let workouts = [];
  let activities = {};
  let weight = null;
  let timer = null;
  let workoutStart = 0;
  let saveQueue = Promise.resolve();

  function message(id, text, error = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", error);
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function legacyKey(base, email = currentUser?.email) {
    return base + "_" + encodeURIComponent(String(email || "").toLowerCase());
  }

  function readLocal(storageKey, fallback) {
    try {
      const value = localStorage.getItem(storageKey);
      return value === null ? fallback : JSON.parse(value);
    } catch (error) {
      console.warn("Could not read legacy local data:", storageKey, error);
      return fallback;
    }
  }

  function writeLocal(storageKey, value) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn("Could not update local cache:", storageKey, error);
      return false;
    }
  }

  function showAuth(mode) {
    $("authSection").hidden = false;
    $("dashboardSection").hidden = true;
    $("loginForm").hidden = mode !== "login";
    $("signupForm").hidden = mode !== "signup";
    $("loginTab").classList.toggle("active", mode === "login");
    $("signupTab").classList.toggle("active", mode === "signup");
    message("loginMessage", "");
    message("signupMessage", "");
  }

  function normalizePayload(payload) {
    const safe = payload && typeof payload === "object" ? payload : {};
    const safeHistory = safe.history && typeof safe.history === "object" &&
      !Array.isArray(safe.history) ? safe.history : {};
    const safeGoals = safe.goals && typeof safe.goals === "object" ? safe.goals : {};
    const safeActivities = safe.activities && typeof safe.activities === "object"
      ? safe.activities : {};

    return {
      history: safeHistory,
      goals: {
        steps: Number(safeGoals.steps) > 0 ? Number(safeGoals.steps) : 8000,
        water: Number(safeGoals.water) > 0 ? Number(safeGoals.water) : 2000,
        calories: Number(safeGoals.calories) > 0 ? Number(safeGoals.calories) : 500
      },
      workouts: Array.isArray(safe.workouts) ? safe.workouts : [],
      activities: safeActivities,
      weight: Number(safe.weight) > 0 ? Number(safe.weight) : null
    };
  }

  function readLegacyData(email) {
    const legacyHistory = readLocal(legacyKey("fitnessTrackerDaily", email), {});
    const legacyGoals = readLocal(legacyKey("fitnessTrackerExtraGoals", email), {});
    const legacyWorkouts = readLocal(legacyKey("fitnessTrackerWorkouts", email), []);
    const legacyActivities = readLocal(legacyKey("fitnessTrackerActivities", email), {});
    const legacyWeight = readLocal(legacyKey("fitnessTrackerWeight", email), null);

    const hasLegacyData =
      localStorage.getItem(legacyKey("fitnessTrackerDaily", email)) !== null ||
      localStorage.getItem(legacyKey("fitnessTrackerExtraGoals", email)) !== null ||
      localStorage.getItem(legacyKey("fitnessTrackerWorkouts", email)) !== null ||
      localStorage.getItem(legacyKey("fitnessTrackerActivities", email)) !== null ||
      localStorage.getItem(legacyKey("fitnessTrackerWeight", email)) !== null;

    return {
      hasLegacyData,
      payload: normalizePayload({
        history: legacyHistory,
        goals: legacyGoals,
        workouts: legacyWorkouts,
        activities: legacyActivities,
        weight: legacyWeight
      })
    };
  }

  function applyPayload(payload) {
    const normalized = normalizePayload(payload);
    history = normalized.history;
    goals = normalized.goals;
    workouts = normalized.workouts;
    activities = normalized.activities;
    weight = normalized.weight;

    data = history[today()] || {
      steps: 0,
      water: 0,
      calories: 0,
      heartRate: null
    };

    data.steps = Number(data.steps || 0);
    data.water = Number(data.water || 0);
    data.calories = Number(data.calories || 0);
    data.heartRate = data.heartRate ? Number(data.heartRate) : null;
  }

  function buildPayload() {
    // Keep the current day's values in the history object before uploading.
    history[today()] = { ...data };

    return {
      history,
      goals,
      workouts,
      activities,
      weight
    };
  }

  function cacheLegacyFormat() {
    if (!currentUser) return;

    const email = currentUser.email;
    writeLocal(legacyKey("fitnessTrackerDaily", email), history);
    writeLocal(legacyKey("fitnessTrackerExtraGoals", email), goals);
    writeLocal(legacyKey("fitnessTrackerWorkouts", email), workouts);
    writeLocal(legacyKey("fitnessTrackerActivities", email), activities);
    writeLocal(legacyKey("fitnessTrackerWeight", email), weight);
  }

  function saveCloud() {
    if (!supabaseClient || !currentUser) return Promise.resolve(false);

    const snapshot = buildPayload();
    cacheLegacyFormat();

    // Queue saves in order so fast successive taps don't overwrite newer data.
    saveQueue = saveQueue
      .catch(() => false)
      .then(async () => {
        const { error } = await supabaseClient
          .from("fitness_tracker_data")
          .upsert({
            user_id: currentUser.id,
            payload: snapshot,
            updated_at: new Date().toISOString()
          }, { onConflict: "user_id" });

        if (error) {
          console.error("Cloud save failed:", error);
          message("historyMessage", "Cloud save failed. Your browser copy remains available; check your connection.", true);
          return false;
        }

        return true;
      });

    return saveQueue;
  }

  async function loadCloudData() {
    const { data: row, error } = await supabaseClient
      .from("fitness_tracker_data")
      .select("payload")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (error) throw error;

    if (row && row.payload) {
      // Existing cloud data takes priority over local cache.
      applyPayload(row.payload);
      cacheLegacyFormat();
      return;
    }

    // First cloud login: preserve and migrate data saved by the old website.
    const legacy = readLegacyData(currentUser.email);
    applyPayload(legacy.payload);

    if (legacy.hasLegacyData) {
      const migrated = await saveCloud();
      if (!migrated) {
        message("historyMessage", "Your old records were loaded, but cloud migration failed. Please check your connection.", true);
      } else {
        message("historyMessage", "Your existing fitness records were migrated to the cloud.");
      }
    } else {
      // Initialize a cloud row for a new account.
      await saveCloud();
    }
  }

  function render() {
    $("stepsCount").textContent = Number(data.steps || 0).toLocaleString();
    $("waterCount").textContent = Number(data.water || 0).toLocaleString();
    $("caloriesCount").textContent = Number(data.calories || 0).toLocaleString();
    $("heartRate").textContent = data.heartRate || "—";

    const targets = [
      ["steps", "goalSteps", "stepsGoalProgress", "stepsGoalBar", "stepsGoalPercent", "steps"],
      ["water", "goalWater", "waterGoalProgress", "waterGoalBar", "waterGoalPercent", "ml"],
      ["calories", "goalCalories", "caloriesGoalProgress", "caloriesGoalBar", "caloriesGoalPercent", "kcal"]
    ];

    targets.forEach(([name, input, text, bar, percentId, unit]) => {
      const target = Math.max(1, Number(goals[name]) || 1);
      const current = Math.max(0, Number(data[name]) || 0);

      $(input).value = target;
      $(text).textContent =
        `${current.toLocaleString()} / ${target.toLocaleString()} ${unit}`;
      $(bar).max = target;
      $(bar).value = Math.min(current, target);
      $(percentId).textContent =
        Math.min(100, Math.round(current / target * 100)) + "%";
    });
  }

  function refreshData() {
    history[today()] = { ...data };
    render();
    renderHistory();
    renderCharts();
    saveCloud();
  }

  async function login(event) {
    event.preventDefault();
    message("loginMessage", "");

    if (!supabaseClient) {
      message("loginMessage", "Database is not configured. Check the Supabase URL and key in script.js.", true);
      return;
    }

    const email = $("loginEmail").value.trim().toLowerCase();
    const password = $("loginPassword").value;

    try {
      const { data: result, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;
      if (!result.user) throw new Error("No user was returned. Please try again.");

      currentUser = {
        id: result.user.id,
        email: result.user.email,
        name: result.user.user_metadata?.name || result.user.email
      };

      $("loginForm").reset();
      await openDashboard();
    } catch (error) {
      console.error("Login failed:", error);
      message("loginMessage", error.message || "Login failed. Check your email and password.", true);
    }
  }

  async function signup(event) {
    event.preventDefault();
    message("signupMessage", "");

    if (!supabaseClient) {
      message("signupMessage", "Database is not configured. Check the Supabase URL and key in script.js.", true);
      return;
    }

    const name = $("signupName").value.trim();
    const email = $("signupEmail").value.trim().toLowerCase();
    const password = $("signupPassword").value;
    const confirmation = $("confirmPassword").value;

    if (name.length < 3) {
      message("signupMessage", "Username must contain at least 3 characters.", true);
      return;
    }
    if (!$("signupEmail").validity.valid) {
      message("signupMessage", "Enter a valid email address.", true);
      return;
    }
    if (password.length < 8) {
      message("signupMessage", "Password must contain at least 8 characters.", true);
      return;
    }
    if (password !== confirmation) {
      message("signupMessage", "The passwords do not match.", true);
      return;
    }

    try {
      const { data: result, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: { name }
        }
      });

      if (error) throw error;

      if (!result.session || !result.user) {
        message(
          "signupMessage",
          "Account created. Check your email to confirm your account, then return here and log in."
        );
        return;
      }

      currentUser = {
        id: result.user.id,
        email: result.user.email,
        name: result.user.user_metadata?.name || name
      };

      $("signupForm").reset();
      await openDashboard();
    } catch (error) {
      console.error("Signup failed:", error);
      message("signupMessage", error.message || "Could not create account.", true);
    }
  }

  async function openDashboard() {
    $("authSection").hidden = true;
    $("dashboardSection").hidden = false;
    $("welcomeUser").textContent = "Hi, " + currentUser.name;
    $("todayLabel").textContent = new Date().toLocaleDateString();
    $("historyDate").value = today();

    try {
      await loadCloudData();
      $("bodyWeight").value = weight || "";
      render();
      renderHistory();
      renderWorkouts();
      renderActivities();
      renderCharts();
    } catch (error) {
      console.error("Could not load cloud data:", error);
      message("historyMessage", "Could not load your cloud data. Check your Supabase setup and connection.", true);
    }
  }

  async function logout() {
    if (timer) clearInterval(timer);
    timer = null;
    workoutStart = 0;

    // Wait for pending cloud writes before ending the session.
    await saveQueue.catch(() => false);

    const { error } = await supabaseClient.auth.signOut();
    if (error) console.error("Logout error:", error);

    currentUser = null;
    showAuth("login");
  }

  async function saveGoals() {
    goals = {
      steps: Math.max(1, Number($("goalSteps").value) || 8000),
      water: Math.max(1, Number($("goalWater").value) || 2000),
      calories: Math.max(1, Number($("goalCalories").value) || 500)
    };

    render();
    renderCharts();
    message("goalsMessage", "Saving goals…");
    const saved = await saveCloud();
    message("goalsMessage", saved ? "Goals saved to your account." : "Goals could not be saved to the cloud.", !saved);
  }

  function getSavedWeight() {
    return Number(weight) || 0;
  }

  function saveManualSteps() {
    const input = $("manualSteps");
    const value = Number(input.value);

    if (input.value.trim() === "" || !Number.isInteger(value) ||
        value < 0 || value > 200000) {
      alert("Enter a whole number of steps from 0 to 200000.");
      return;
    }

    data.steps = value;
    refreshData();
    if (getSavedWeight()) estimateCalories();
  }

  async function saveBodyWeight() {
    const input = $("bodyWeight");
    const value = Number(input.value);

    if (input.value.trim() === "" || !Number.isFinite(value) ||
        value < 20 || value > 300) {
      alert("Enter a body weight between 20 and 300 kg.");
      return;
    }

    weight = value;
    estimateCalories();
    const saved = await saveCloud();

    message("calorieEstimateMessage",
      saved ? "Weight and calorie estimate saved to your account." :
        "Weight was updated locally, but cloud saving failed.", !saved);
  }

  function estimateCalories() {
    const savedWeight = getSavedWeight();

    if (!savedWeight) {
      message("calorieEstimateMessage", "Save your body weight to estimate calories.");
      return;
    }

    const distanceKm = Number(data.steps || 0) * 0.75 / 1000;
    data.calories = Math.round(savedWeight * distanceKm * 0.5);
    refreshData();

    message(
      "calorieEstimateMessage",
      `Estimated distance: ${distanceKm.toFixed(2)} km · Estimated calories: ${data.calories} kcal. This is only an estimate.`
    );
  }

  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
  }

  function startWorkout() {
    if (timer) return;

    workoutStart = Date.now();
    $("startWorkout").disabled = true;
    $("stopWorkout").disabled = false;
    message("workoutMessage", "Workout in progress.");

    timer = setInterval(() => {
      $("workoutClock").textContent =
        formatTime(Math.floor((Date.now() - workoutStart) / 1000));
    }, 500);
  }

  async function finishWorkout() {
    if (!timer) {
      message("workoutMessage", "Start a workout before finishing.", true);
      return;
    }

    const seconds = Math.floor((Date.now() - workoutStart) / 1000);
    clearInterval(timer);
    timer = null;
    workoutStart = 0;

    $("workoutClock").textContent = formatTime(seconds);
    $("startWorkout").disabled = false;
    $("stopWorkout").disabled = true;

    if (seconds > 0) {
      workouts.push({
        date: today(),
        type: $("workoutType").value,
        seconds
      });

      renderWorkouts();
      const saved = await saveCloud();
      message("workoutMessage", saved ? "Workout saved to your account." : "Workout could not be saved to the cloud.", !saved);
    } else {
      message("workoutMessage", "Workout was too short to record.", true);
    }
  }

  async function updateActivities() {
    activities[today()] = [...document.querySelectorAll(".daily-activity:checked")]
      .map(box => box.value);

    renderActivities();
    const saved = await saveCloud();

    if (!saved) message("activityProgress", "Checklist updated locally, but cloud saving failed.", true);
  }

  function renderActivities() {
    const done = activities[today()] || [];

    document.querySelectorAll(".daily-activity").forEach(box => {
      box.checked = done.includes(box.value);
    });

    $("activityProgress").textContent =
      `${done.length} of ${document.querySelectorAll(".daily-activity").length} activities completed`;
  }

  function renderWorkouts() {
    const body = $("workoutHistory");
    body.replaceChildren();

    if (!workouts.length) {
      const row = body.insertRow();
      row.insertCell().textContent = "No workouts recorded yet.";
      row.cells[0].colSpan = 3;
      return;
    }

    workouts.slice().reverse().forEach(workout => {
      const row = body.insertRow();
      row.insertCell().textContent = workout.date || "";
      row.insertCell().textContent = workout.type || "Other";
      row.insertCell().textContent = formatTime(Number(workout.seconds) || 0);
    });
  }

  function renderHistory() {
    const body = $("historyTable");
    body.replaceChildren();

    const dates = Object.keys(history).sort().reverse();

    if (!dates.length) {
      const row = body.insertRow();
      row.insertCell().textContent = "No records available.";
      row.cells[0].colSpan = 5;
      return;
    }

    dates.forEach(date => {
      const item = history[date] || {};
      const row = body.insertRow();

      [
        date,
        item.steps || 0,
        item.calories || 0,
        item.water || 0,
        item.heartRate || "—"
      ].forEach(value => row.insertCell().textContent = value);
    });
  }

  async function saveRecord() {
    const date = $("historyDate").value;

    if (!date) {
      message("historyMessage", "Please select a date.", true);
      return;
    }

    if (date !== today()) {
      message("historyMessage", "You can save the current day's record only.", true);
      return;
    }

    history[today()] = { ...data };
    renderHistory();
    renderCharts();

    const saved = await saveCloud();
    message("historyMessage", saved ? "Today's record saved to your account." : "Cloud save failed. Check your connection.", !saved);
  }

  function getChartDates(days) {
    const dates = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);

      dates.push(
        d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0")
      );
    }

    return dates;
  }

  function updateAnalytics(dates) {
    const records = dates.map(date =>
      history[date] || (date === today() ? data : null)
    );

    const steps = records.reduce((sum, item) => sum + Number(item?.steps || 0), 0);
    const calories = records.reduce((sum, item) => sum + Number(item?.calories || 0), 0);
    const water = records.reduce((sum, item) => sum + Number(item?.water || 0), 0);

    $("analyticsTotalSteps").textContent = steps.toLocaleString();
    $("analyticsAverageSteps").textContent =
      Math.round(steps / Math.max(1, dates.length)).toLocaleString();
    $("analyticsTotalCalories").textContent = calories.toLocaleString();
    $("analyticsAverageWater").textContent =
      Math.round(water / Math.max(1, dates.length)).toLocaleString() + " ml";

    const goal = Math.max(1, Number(goals.steps) || 8000);
    const goalDays = records.filter(item =>
      Number(item?.steps || 0) >= goal
    ).length;

    const recordedDays = records.filter(item => item && (
      Number(item.steps || 0) > 0 ||
      Number(item.calories || 0) > 0 ||
      Number(item.water || 0) > 0 ||
      Number(item.heartRate || 0) > 0
    )).length;

    let insight;

    if (recordedDays === 0) {
      insight = "Start recording your activity to unlock personal insights.";
    } else if (goalDays > 0) {
      insight = `Great work! You reached your ${goal.toLocaleString()}-step goal on ${goalDays} of ${dates.length} days in this period.`;
    } else {
      insight = `You've recorded activity on ${recordedDays} of ${dates.length} days. Keep building consistency toward your ${goal.toLocaleString()}-step goal.`;
    }

    $("analyticsInsight").textContent = insight;
  }

  function drawChart(id, metric, dates) {
    const canvas = $(id);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = Math.max(280, canvas.clientWidth || 300);
    const height = 180;
    const ratio = window.devicePixelRatio || 1;

    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const values = dates.map(date => {
      const item = history[date] || (date === today() ? data : {});
      return Number(item?.[metric] || 0);
    });

    const max = Math.max(1, ...values);
    const left = 42, top = 16, bottom = 32, right = 12;
    const plotHeight = height - top - bottom;
    const plotWidth = width - left - right;
    const slotWidth = plotWidth / dates.length;
    const barWidth = Math.max(2, Math.min(22, slotWidth * 0.58));

    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px Arial";
    ctx.textAlign = "right";
    ctx.fillStyle = "#718096";
    ctx.strokeStyle = "#e5eaf2";
    ctx.lineWidth = 1;

    for (let i = 0; i <= 4; i++) {
      const y = top + plotHeight * i / 4;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(width - right, y);
      ctx.stroke();
      ctx.fillText(Math.round(max * (4 - i) / 4).toLocaleString(), left - 7, y + 3);
    }

    values.forEach((value, i) => {
      const x = left + (i + 0.5) * slotWidth;
      const barHeight = value / max * plotHeight;
      const y = top + plotHeight - barHeight;

      const gradient = ctx.createLinearGradient(0, y, 0, top + plotHeight);
      gradient.addColorStop(0, "#6389f5");
      gradient.addColorStop(1, "#3155c9");
      ctx.fillStyle = gradient;

      if (barHeight > 0) {
        const radius = Math.min(4, barWidth / 2, barHeight / 2);
        ctx.beginPath();
        ctx.moveTo(x - barWidth / 2, top + plotHeight);
        ctx.lineTo(x - barWidth / 2, y + radius);
        ctx.quadraticCurveTo(x - barWidth / 2, y, x - barWidth / 2 + radius, y);
        ctx.lineTo(x + barWidth / 2 - radius, y);
        ctx.quadraticCurveTo(x + barWidth / 2, y, x + barWidth / 2, y + radius);
        ctx.lineTo(x + barWidth / 2, top + plotHeight);
        ctx.closePath();
        ctx.fill();
      }

      const labelEvery = dates.length <= 7 ? 1 : dates.length <= 14 ? 2 : 5;

      if (i % labelEvery === 0 || i === dates.length - 1) {
        ctx.fillStyle = "#718096";
        ctx.textAlign = "center";
        ctx.fillText(dates[i].slice(5), x, height - 10);
      }
    });
  }

  function renderCharts() {
    const days = Number($("chartRange")?.value || 7);
    const dates = getChartDates(days);

    updateAnalytics(dates);
    drawChart("stepsChart", "steps", dates);
    drawChart("caloriesChart", "calories", dates);
    drawChart("waterChart", "water", dates);
    drawChart("heartRateChart", "heartRate", dates);
  }

  function attachEvents() {
    $("loginForm").addEventListener("submit", login);
    $("signupForm").addEventListener("submit", signup);
    $("loginTab").addEventListener("click", () => showAuth("login"));
    $("signupTab").addEventListener("click", () => showAuth("signup"));
    $("showSignup").addEventListener("click", () => showAuth("signup"));
    $("showLogin").addEventListener("click", () => showAuth("login"));
    $("logoutButton").addEventListener("click", logout);

    $("addSteps").addEventListener("click", () => {
      data.steps = Number(data.steps || 0) + 100;
      refreshData();
    });

    $("saveSteps").addEventListener("click", saveManualSteps);
    $("saveWeight").addEventListener("click", saveBodyWeight);

    $("addWater").addEventListener("click", () => {
      data.water = Number(data.water || 0) + 250;
      refreshData();
    });

    $("saveHeartRate").addEventListener("click", () => {
      const value = Number($("heartRateInput").value);

      if (!value || value < 1 || value > 250) {
        alert("Enter a heart rate between 1 and 250.");
        return;
      }

      data.heartRate = value;
      $("heartRateInput").value = "";
      refreshData();
    });

    $("saveCalories").addEventListener("click", () => {
      const input = $("caloriesInput");
      const value = Number(input.value);

      if (input.value.trim() === "" || !Number.isFinite(value) ||
          value < 0 || value > 100000) {
        alert("Enter a valid calorie value.");
        return;
      }

      data.calories = value;
      input.value = "";
      refreshData();
      message("calorieEstimateMessage", "Manual calorie entry saved.");
    });

    $("saveFitnessGoals").addEventListener("click", saveGoals);
    $("startWorkout").addEventListener("click", startWorkout);
    $("stopWorkout").addEventListener("click", finishWorkout);
    $("saveRecord").addEventListener("click", saveRecord);
    $("chartRange").addEventListener("change", renderCharts);

    $("goalSteps").addEventListener("change", async () => {
      goals.steps = Math.max(1, Number($("goalSteps").value) || 8000);
      render();
      renderCharts();
      await saveCloud();
    });

    document.querySelectorAll(".daily-activity").forEach(box => {
      box.addEventListener("change", updateActivities);
    });

    window.addEventListener("resize", () => {
      if (currentUser && !$("dashboardSection").hidden) renderCharts();
    });
  }

  function validateConfig() {
    const urlValid = SUPABASE_URL.startsWith("https://") &&
      !SUPABASE_URL.includes("PASTE_YOUR");
    const keyValid = SUPABASE_PUBLISHABLE_KEY.length > 20 &&
      !SUPABASE_PUBLISHABLE_KEY.includes("PASTE_YOUR");

    if (!urlValid || !keyValid) {
      showAuth("login");
      message(
        "loginMessage",
        "Setup needed: add your Supabase Project URL and publishable/anon key in script.js.",
        true
      );
      return false;
    }

    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      showAuth("login");
      message("loginMessage", "Supabase library did not load. Check your internet connection and reload.", true);
      return false;
    }

    supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY
    );
    return true;
  }

  attachEvents();

  if (!validateConfig()) return;

  try {
    const { data: result, error } = await supabaseClient.auth.getSession();
    if (error) throw error;

    const user = result.session?.user;

    if (user) {
      currentUser = {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.name || user.email
      };
      await openDashboard();
    } else {
      showAuth("login");
    }
  } catch (error) {
    console.error("Startup failed:", error);
    showAuth("login");
    message("loginMessage", "Could not connect to Supabase. Check your configuration and internet connection.", true);
  }

  // React to expired sessions or sign-in/sign-out changes.
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      showAuth("login");
    }
  });
});
