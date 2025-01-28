const { ipcRenderer, shell } = require('electron');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Path to your local database file
const DB_PATH = `${__dirname}/database.db`;

// Initialize the database
let db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Failed to open DB:', err);
  } else {
    console.log('Database opened successfully.');
  }
});

// Track which note is being edited. Null means new note.
let currentlyEditingNoteId = null;

// Quill editor reference
let quill = null;

// Track note-taker mode
let isNoteTakerMode = false;

// Get references to the search input and notes container
const searchInput = document.getElementById('note-search');
const notesContainer = document.getElementById('notes-container');

/****************************************************************
 * 0) Note Filtering
 ****************************************************************/
function filterNotes(query) {
  const notes = notesContainer.getElementsByClassName('note');
  const lowerCaseQuery = query.toLowerCase();

  Array.from(notes).forEach((note) => {
    const title = note.querySelector('h3').textContent.toLowerCase();
    const content = note.querySelector('.note-content').textContent.toLowerCase();

    note.style.display =
      title.includes(lowerCaseQuery) || content.includes(lowerCaseQuery)
        ? 'flex'
        : 'none';
  });
}

searchInput?.addEventListener('input', (event) => {
  const query = event.target.value.trim();
  filterNotes(query);
});

/****************************************************************
 * 1) Masking Logic
 ****************************************************************/
function maskPhone10CharDigitWindow(text) {
  const maskLength = 10;
  const digitThreshold = 6;
  let masked = '';
  let i = 0;

  while (i < text.length) {
    const windowText = text.slice(i, i + maskLength);
    const digitCount = (windowText.match(/\d/g) || []).length;

    if (digitCount > digitThreshold) {
      masked += '*******';
      i += maskLength;
    } else {
      masked += text[i];
      i++;
    }
  }
  return masked;
}

function blockAtSignRegion(text) {
  let result = '';
  let lastIndex = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] === '@') {
      const blockStart = Math.max(0, i - 6);
      const blockEnd = Math.min(text.length - 1, i + 5);

      if (blockStart > lastIndex) {
        result += text.slice(lastIndex, blockStart);
      }
      const lengthToMask = blockEnd - blockStart + 1;
      result += '*'.repeat(lengthToMask);

      i = blockEnd + 1;
      lastIndex = i;
    } else {
      i++;
    }
  }
  // Append leftover text
  if (lastIndex < text.length) {
    result += text.slice(lastIndex);
  }
  return result;
}

function maskSensitiveInfo(text) {
  let masked = maskPhone10CharDigitWindow(text);
  masked = blockAtSignRegion(masked);
  return masked;
}

function maskSensitiveInfoHTML(contentHTML) {
  // Create a temporary DOM element to parse the HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = contentHTML;

  // Traverse and mask text nodes
  (function traverse(node) {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        child.textContent = maskSensitiveInfo(child.textContent);
      } else {
        traverse(child);
      }
    });
  })(tempDiv);

  return tempDiv.innerHTML;
}

/****************************************************************
 * 2) Database Logic for Notes
 ****************************************************************/
function checkAndAddLastUpdatedColumn(callback) {
  db.all(`PRAGMA table_info(notes)`, [], (err, columns) => {
    if (err) {
      console.error('Error reading table info:', err);
      return;
    }
    const columnNames = columns.map((col) => col.name);
    if (!columnNames.includes('last_updated')) {
      db.run(
        `ALTER TABLE notes ADD COLUMN last_updated DATETIME DEFAULT CURRENT_TIMESTAMP`,
        [],
        (err) => {
          if (err) {
            console.error('Error adding last_updated column:', err);
          }
          if (callback) callback();
        }
      );
    } else {
      if (callback) callback();
    }
  });
}

function initDatabase(callback) {
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      alert('Failed to open the database. Please restart the application.');
      return;
    }
    db.serialize(() => {
      db.run(
        `
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY,
          title TEXT,
          content TEXT,
          last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `,
        (err) => {
          if (err) {
            alert('Failed to create the notes table.');
          } else {
            checkAndAddLastUpdatedColumn(() => {
              if (callback) callback();
            });
          }
        }
      );
    });
  });
}

function createNote(title, content) {
  const currentTimestamp = new Date().toISOString();
  db.run(
    `INSERT INTO notes (title, content, last_updated) VALUES (?, ?, ?)`,
    [title, content, currentTimestamp],
    (err) => {
      if (err) {
        alert('Failed to create the note. Please try again.');
        return;
      }
      loadNotes();
    }
  );
}

function updateNote(noteId, newTitle, newContent) {
  const currentTimestamp = new Date().toISOString();
  db.run(
    `UPDATE notes
     SET title = ?, content = ?, last_updated = ?
     WHERE id = ?`,
    [newTitle, newContent, currentTimestamp, noteId],
    (err) => {
      if (err) {
        alert('Failed to update the note. Please try again.');
        return;
      }
      loadNotes();
    }
  );
}

/****************************************************************
 * 3) Main App Logic (Saving, Editing, Deleting)
 ****************************************************************/
async function deleteNote(noteId) {
  try {
    const confirmation = await ipcRenderer.invoke(
      'show-confirm-dialog',
      'Are you sure you want to delete this note?'
    );
    if (!confirmation) return;

    db.run(`DELETE FROM notes WHERE id = ?`, [noteId], (err) => {
      if (err) {
        alert('Failed to delete the note. Please try again.');
        return;
      }
      loadNotes();
      resetEditor();
    });
  } catch (error) {
    alert('An unexpected error occurred during deletion.');
  }
}

async function saveNote() {
  const titleInput = document.getElementById('note-title');
  let title = titleInput?.value.trim();
  let contentHTML = quill?.root.innerHTML.trim();

  // Basic validation
  if (!title || !contentHTML) {
    await ipcRenderer.invoke(
      'show-error-dialog',
      'Please provide both a title and content.'
    );
    // Restore focus
    if (!title && titleInput) {
      titleInput.focus();
    } else if (quill) {
      quill.focus();
    }
    return;
  }

  // Masking
  title = maskSensitiveInfoHTML(title);
  contentHTML = maskSensitiveInfoHTML(contentHTML);

  if (currentlyEditingNoteId === null) {
    createNote(title, contentHTML);
  } else {
    updateNote(currentlyEditingNoteId, title, contentHTML);
  }
  resetEditor();
}

function resetEditor() {
  currentlyEditingNoteId = null;

  const titleInput = document.getElementById('note-title');
  const saveButton = document.getElementById('save-note-button');
  const cancelButton = document.getElementById('cancel-edit-button');

  if (titleInput) titleInput.value = '';
  if (quill) {
    quill.root.innerHTML = '';
    quill.enable(true);
    quill.focus();
  }
  if (saveButton) saveButton.textContent = 'Save Note';
  if (cancelButton) cancelButton.style.display = 'none';

  // Exit any full-screen notes
  const fullScreenNotes = document.querySelectorAll('.note.full-screen');
  fullScreenNotes.forEach((note) => {
    note.classList.remove('full-screen');
    const fsButton = note.querySelector('.button-row button:last-child');
    if (fsButton) fsButton.textContent = 'Full Screen';
  });
}

function enterEditMode(noteId, oldTitle, oldContent) {
  currentlyEditingNoteId = noteId;

  const titleInput = document.getElementById('note-title');
  const saveButton = document.getElementById('save-note-button');
  const cancelButton = document.getElementById('cancel-edit-button');

  if (titleInput) titleInput.value = oldTitle;
  if (quill) quill.root.innerHTML = oldContent;
  if (saveButton) saveButton.textContent = 'Update Note';
  if (cancelButton) cancelButton.style.display = 'inline-block';

  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (quill) quill.focus();
}

/****************************************************************
 * 3.5) Helper: Create Note Buttons (Edit, Full Screen, Delete)
 ****************************************************************/
function createNoteButtons(row, noteDiv, content) {
  const buttonRow = document.createElement('div');
  buttonRow.className = 'button-row';

  const buttonRowLeft = document.createElement('div');
  buttonRowLeft.className = 'button-row-left';

  const buttonRowRight = document.createElement('div');
  buttonRowRight.className = 'button-row-right';

  // Edit
  const editButton = document.createElement('button');
  editButton.textContent = 'Edit';
  editButton.classList.add('button', 'edit-button');
  editButton.onclick = () => {
    if (noteDiv.classList.contains('full-screen')) {
      toggleFullScreen(noteDiv, fullScreenButton);
    }
    enterEditMode(row.id, row.title, content);
  };

  // Full Screen
  const fullScreenButton = document.createElement('button');
  fullScreenButton.textContent = 'Full Screen';
  fullScreenButton.classList.add('button', 'fullscreen-button');
  fullScreenButton.onclick = () => {
    toggleFullScreen(noteDiv, fullScreenButton);
  };

  // Delete
  const deleteButton = document.createElement('button');
  deleteButton.textContent = 'Delete';
  deleteButton.classList.add('button', 'delete-button');
  deleteButton.onclick = () => {
    deleteNote(row.id);
  };

  // Append
  buttonRowLeft.appendChild(editButton);
  buttonRowLeft.appendChild(fullScreenButton);
  buttonRowRight.appendChild(deleteButton);
  buttonRow.appendChild(buttonRowLeft);
  buttonRow.appendChild(buttonRowRight);

  return buttonRow;
}

/****************************************************************
 * 4) Load Notes
 ****************************************************************/
function loadNotes() {
  if (!notesContainer) return;
  notesContainer.innerHTML = '';

  db.all(`SELECT * FROM notes ORDER BY last_updated DESC`, [], (err, rows) => {
    if (err) {
      alert('Failed to load notes. Please try again.');
      return;
    }
    rows.forEach((row) => {
      try {
        const content = row.content;

        let lastUpdatedDate;
        if (row.last_updated.endsWith('Z')) {
          lastUpdatedDate = new Date(row.last_updated);
        } else {
          lastUpdatedDate = new Date(row.last_updated + 'Z');
        }
        if (isNaN(lastUpdatedDate)) {
          lastUpdatedDate = new Date();
        }

        const dateOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
        const timeOptions = {
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
          hour12: true,
        };
        const formattedDate = `${lastUpdatedDate.toLocaleDateString(
          undefined,
          dateOptions
        )} at ${lastUpdatedDate.toLocaleTimeString(undefined, timeOptions)}`;

        const noteDiv = document.createElement('div');
        noteDiv.className = 'note';
        noteDiv.innerHTML = `
          <h3 title="${row.title}">${row.title}</h3>
          <div class="save-date">Saved On: ${formattedDate}</div>
          <div class="note-content">${content}</div>
        `;

        const buttonRow = createNoteButtons(row, noteDiv, content);
        noteDiv.appendChild(buttonRow);
        notesContainer.appendChild(noteDiv);
      } catch (error) {
        console.error('Error rendering note:', error);
      }
    });

    // Append extra-space after loading all notes
    const extraSpaceDiv = document.createElement('div');
    extraSpaceDiv.className = 'extra-space';
    notesContainer.appendChild(extraSpaceDiv);
  });
}

/****************************************************************
 * 5) NoteTaker Mode Toggling
 ****************************************************************/
function toggleNoteTakerMode() {
  ipcRenderer.send('toggle-note-taker-mode');
}

ipcRenderer.on('note-taker-mode-changed', (event, newMode) => {
  isNoteTakerMode = newMode;

  const container = document.getElementById('app-container');
  const noteTakerBtn = document.getElementById('note-taker-button');
  const html = document.documentElement;
  const body = document.body;

  if (isNoteTakerMode) {
    container?.classList.add('note-taker-mode');
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    if (noteTakerBtn) noteTakerBtn.textContent = 'View All Notes';
  } else {
    container?.classList.remove('note-taker-mode');
    html.style.overflow = '';
    body.style.overflow = '';
    if (noteTakerBtn) noteTakerBtn.textContent = 'NoteTaker Mode';

    // Exit any full-screen notes
    const fullScreenNotes = document.querySelectorAll('.note.full-screen');
    fullScreenNotes.forEach((note) => {
      note.classList.remove('full-screen');
      const fsButton = note.querySelector('.button-row button:last-child');
      if (fsButton) fsButton.textContent = 'Full Screen';
    });
  }
});

/****************************************************************
 * 5.5) Full Screen Mode Toggling
 ****************************************************************/
function toggleFullScreen(noteDiv, button) {
  const isFullScreen = noteDiv.classList.contains('full-screen');
  if (!isFullScreen) {
    noteDiv.classList.add('full-screen');
    button.textContent = 'Minimize';
  } else {
    noteDiv.classList.remove('full-screen');
    button.textContent = 'Full Screen';
  }
}

/****************************************************************
 * 6) Panel Navigation (Saved Notes -> Directory -> Resorts)
 ****************************************************************/
let panelIndex = 0;
const panelIds = ['saved-notes-panel', 'directory-panel', 'resorts-panel'];

function showPanel(index) {
  panelIds.forEach((id, i) => {
    const panelEl = document.getElementById(id);
    if (panelEl) {
      panelEl.classList.toggle('active', i === index);
      panelEl.classList.toggle('hidden', i !== index);
    }
  });
}

function nextPanel() {
  panelIndex = (panelIndex + 1) % panelIds.length;
  showPanel(panelIndex);
}

function prevPanel() {
  panelIndex = (panelIndex + panelIds.length - 1) % panelIds.length;
  showPanel(panelIndex);
}

document.getElementById('panel-forward-button')?.addEventListener('click', nextPanel);
document.getElementById('panel-back-button')?.addEventListener('click', prevPanel);

/********************************************************
 * Directory Data & Functions
 ********************************************************/
let directoryData = [];

// 1) Fetch directory.json and parse
function loadDirectoryData() {
  return fetch('directory.json')
    .then(response => {
      if (!response.ok) {
        throw new Error("Failed to fetch directory.json");
      }
      return response.json();
    })
    .then(jsonData => {
      directoryData = jsonData; // store into our global array
    })
    .catch(err => {
      console.error("Error loading directory data:", err);
    });
}

/**
 * Build the contact info as HTML, only showing fields that have data.
 */
function buildContactHTML(contact) {
  if (!contact) return "";

  let contactLines = [];

  // 1) Phone Numbers
  if (contact.phones) {
    const phoneEntries = Object.entries(contact.phones);
    phoneEntries.forEach(([type, phoneNumber]) => {
      if (phoneNumber) {
        contactLines.push(
          `<div class="phone-line"><strong>${type.toUpperCase()}:</strong> ${phoneNumber}</div>`
        );
      }
    });
  }

  // 2) Website Info
  if (contact.website) {
    const { url, username, password } = contact.website;
    if (url) {
      contactLines.push(
        `<div class="website-line"><strong>URL:</strong> <a href="${url}" target="_blank">${url}</a></div>`
      );
    }
    if (username) {
      contactLines.push(
        `<div style="margin-left: 50px;" class="website-line"><strong>Username:</strong> ${username}</div>`
      );
    }
    if (password) {
      contactLines.push(
        `<div style="margin-left: 50px;" class="website-line"><strong>Password:</strong> ${password}</div>`
      );
    }
  }

 // 3) Multiple Websites
 if (contact.websites && Array.isArray(contact.websites)) {
  contact.websites.forEach((website, index) => {
    if (website.url) {
      const displayText = website.displayText || "CLICK HERE";
      contactLines.push(
        `<div class="website-line">
          <strong>${website.name || 'Website ' + (index + 1)}:</strong>
          <a href="${website.url}" target="_blank" rel="noopener noreferrer">${displayText}</a>
        </div>`
      );
    }
  });
}

  // 4) Email
  if (contact.email) {
    contactLines.push(
      `<div class="email-line"><strong>Email:</strong> <a href="mailto:${contact.email}">${contact.email}</a></div>`
    );
  }

  // 5) Info
  if (contact.info) {
    contactLines.push(
      `<div class="info-line"><strong>INFO:</strong> ${contact.info}</div>`
    );
  }

  // 6) Genesys Contact
  if (contact.genesysContact) {
    contactLines.push(
      `<div class="info-line"><strong>Genesys Contact:</strong> ${contact.genesysContact}</div>`
    );
  }

  // 7) Operating Hours
  if (contact.hours) {
    contactLines.push(
      `<div class="hours-line"><strong>Hours of Operation:</strong> ${contact.hours}</div>`
    );
  }

  // 8) Contracts
  if (contact.contracts) {
    contactLines.push(
      `<div class="contracts-line"><strong>Contracts:</strong> ${contact.contracts}</div>`
    );
  }

  return contactLines.join("");
}

function buildDirectoryTableHTML(data) {
  // Build <tr> elements for each entry
  const rows = data.map(entry => {
    const { name = "", contact = {} } = entry;
    const contactHTML = buildContactHTML(contact);

    return `
      <tr>
        <td class="dir-name">${name}</td>
        <td class="dir-contact">${contactHTML}</td>
      </tr>
    `;
  }).join("");

  // Combine the rows into a table
  return `
    <table id="directory-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Contact</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

/**
 * Sort the data by `name`, then render the table.
 */
function renderDirectoryTable(data) {
  // Always sort the data alphabetically by name before building the table
  data.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const container = document.querySelector("#directory-container");
  if (!container) return;

  const tableHTML = buildDirectoryTableHTML(data);
  container.innerHTML = tableHTML;
}

function filterDirectoryData(searchValue) {
  const query = searchValue.toLowerCase();
  // Filter logic checks each field
  return directoryData.filter(entry => {
    const { name = "", contact = {} } = entry;
    const { phones = {}, website = {}, email = "" } = contact;

    // Build a big string containing all relevant info
    let combined = name + " " + email;

    // phones
    for (let phoneType in phones) {
      combined += " " + phones[phoneType];
    }
    // website
    if (website.url) combined += " " + website.url;
    if (website.username) combined += " " + website.username;
    if (website.password) combined += " " + website.password;

    // Return true if the combined text matches the search query
    return combined.toLowerCase().includes(query);
  });
}

/**
 * Initialize the directory:
 * 1) Load the data from the JSON
 * 2) Render once loaded
 * 3) Attach search
 */
function initDirectory() {
  loadDirectoryData().then(() => {
    // 1) Now directoryData is filled from JSON
    renderDirectoryTable(directoryData);

    // 2) Set up search
    const searchInput = document.getElementById("directory-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        const searchTerm = searchInput.value.trim();
        const filtered = filterDirectoryData(searchTerm);
        renderDirectoryTable(filtered);

        // Scroll the directory-container to the top
        const directoryContainer = document.getElementById("directory-container");
        if (directoryContainer) {
          directoryContainer.scrollTop = 0; // For scrollable container

          // Alternatively, if you want to scroll the entire page to the container:
          // directoryContainer.scrollIntoView({ behavior: "smooth" });
        }
      });
    }
  });
}


/****************************************************************
 * Resort Data & Functions (Example Only)
 ****************************************************************/
let resortData = [];

// Function to fetch the JSON file and parse it
function loadResortData() {
  return fetch('resort.json')
    .then(response => {
      if (!response.ok) {
        throw new Error("Failed to fetch resort.json");
      }
      return response.json();
    })
    .then(jsonData => {
      resortData = jsonData; // store into our global array
    })
    .catch(err => {
      console.error("Error loading resort data:", err);
    });
}

function buildResortHTML(resort) {
  const {
    code = "",
    name = "",
    profile = "",
    phone = "",
    location = "",
    sublocation = "",
    distanceFromAirport = "",
    category = "",
    openingDate = ""
  } = resort;

  let lines = [];
  if (code) lines.push(`<div><strong>Code:</strong> ${code}</div>`);
  if (profile) lines.push(`<div><strong>Profile:</strong> ${profile}</div>`);
  if (phone) lines.push(`<div><strong>Phone:</strong> ${phone}</div>`);
  if (location) lines.push(`<div><strong>Location:</strong> ${location}</div>`);
  if (sublocation) lines.push(`<div><strong>Sublocation:</strong> ${sublocation}</div>`);
  if (distanceFromAirport) lines.push(`<div><strong>Distance from Airport:</strong> ${distanceFromAirport}</div>`);
  if (category) lines.push(`<div><strong>Category:</strong> ${category}</div>`);
  if (openingDate) lines.push(`<div><strong>Opening Date:</strong> ${openingDate}</div>`);

  return lines.join("");
}

function buildResortTableHTML(data) {
  const rows = data.map(resort => {
    const { name = "" } = resort;
    const resortInfoHTML = buildResortHTML(resort);

    return `
      <tr>
        <td class="resort-name">${name}</td>
        <td class="resort-details">${resortInfoHTML}</td>
      </tr>
    `;
  }).join("");

  return `
    <table id="resort-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <div class="extra-space"></div>
  `;
}

function renderResortTable(data) {
  const container = document.querySelector("#resort-container");
  if (!container) return;

  const tableHTML = buildResortTableHTML(data);
  container.innerHTML = tableHTML;
}

function filterResortData(searchValue) {
  const query = searchValue.toLowerCase();
  return resortData.filter(resort => {
    const {
      code = "",
      name = "",
      profile = "",
      phone = "",
      location = "",
      sublocation = "",
      distanceFromAirport = "",
      category = "",
      openingDate = ""
    } = resort;

    let combined = `
      ${code}
      ${name}
      ${profile}
      ${phone}
      ${location}
      ${sublocation}
      ${distanceFromAirport}
      ${category}
      ${openingDate}
    `;
    return combined.toLowerCase().includes(query);
  });
}

/**
 * Initialize the resort directory:
 * 1) Load the data from the JSON
 * 2) Render once loaded
 * 3) Attach search
 */
function initResortDirectory() {
  loadResortData().then(() => {
    // 1) Now resortData is filled
    renderResortTable(resortData);

    // 2) Set up search listener
    const searchInput = document.getElementById("resort-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        const searchTerm = searchInput.value.trim();
        const filtered = filterResortData(searchTerm);
        renderResortTable(filtered);

        // Scroll the resort-container to the top
        const resortContainer = document.getElementById("resort-container");
        if (resortContainer) {
          resortContainer.scrollTop = 0; // For scrollable container

          // Alternatively, if you want to scroll the entire page to the container:
          // resortContainer.scrollIntoView({ behavior: "smooth" });
        }
      });
    }
  });
}



/****************************************************************
 * 7) Current Time Display
 ****************************************************************/
function updateCurrentTime() {
  const currentTimeDiv = document.getElementById('current-time');
  if (!currentTimeDiv) return;

  const now = new Date();

  // Date
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const dateTime = dateFormatter.format(now);

  // Eastern
  const easternFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const easternTime = easternFormatter.format(now);

  // Central
  const centralFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const centralTime = centralFormatter.format(now);

  // Mountain
  const mountainFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const mountainTime = mountainFormatter.format(now);

  // Pacific
  const pacificFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const pacificTime = pacificFormatter.format(now);

  currentTimeDiv.innerHTML = `
    <div class="label">Date: </div>
    <div class="value">${dateTime}</div>

    <div class="label">Eastern: </div>
    <div class="value">${easternTime}</div>

    <div class="label">Mountain: </div>
    <div class="value">${mountainTime}</div>

    <div class="label">Central: </div>
    <div class="value">${centralTime}</div>

    <div class="label">Pacific: </div>
    <div class="value">${pacificTime}</div>
  `;
}

/****************************************************************
 * 8) On Window Load
 ****************************************************************/
window.onload = () => {
  const requiredIds = [
    'note-title',
    'save-note-button',
    'cancel-edit-button',
    'note-taker-button',
    'app-container',
    'editor',
  ];
  const missingElements = requiredIds.some((id) => !document.getElementById(id));
  if (missingElements) {
    console.warn('Some required elements are missing from the DOM.');
    return;
  }

  // 8.1) Notes DB
  initDatabase(() => {
    quill = new Quill('#editor', {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ header: [1, 2, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link', 'image'],
        ],
      },
      placeholder: '    Start typing your note here...',
    });

    // External links -> shell
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      let target = event.target;
      while (target && target !== document) {
        if (target.tagName?.toLowerCase() === 'a') {
          event.preventDefault();
          const href = target.getAttribute('href');
          if (href) {
            try {
              const url = new URL(href);
              shell.openExternal(url.toString());
            } catch (e) {
              console.error('Invalid URL:', href);
            }
          }
          break;
        }
        target = target.parentNode;
      }
    });

    const saveButton = document.getElementById('save-note-button');
    const cancelButton = document.getElementById('cancel-edit-button');
    const noteTakerButton = document.getElementById('note-taker-button');

    if (saveButton) saveButton.onclick = saveNote;
    if (cancelButton) cancelButton.onclick = resetEditor;
    if (noteTakerButton) noteTakerButton.onclick = toggleNoteTakerMode;

    loadNotes();
    resetEditor();
  });

  // 8.2) Init Directory Panel (in-memory example)
  initDirectory();
  initResortDirectory();

  // 8.3) Initialize time display
  updateCurrentTime();
  setInterval(updateCurrentTime, 1000);

  // Show the first panel by default
  showPanel(panelIndex);
};

// Allow pressing Escape to exit full-screen note
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const fullScreenNotes = document.querySelectorAll('.note.full-screen');
    fullScreenNotes.forEach((note) => {
      note.classList.remove('full-screen');
      const fsButton = note.querySelector('.button-row button:last-child');
      if (fsButton) fsButton.textContent = 'Full Screen';
    });
  }
});
