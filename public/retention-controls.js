(function () {
  "use strict";

  var tool = document.querySelector("[data-retention-tools]");
  if (!tool) return;

  var search = tool.querySelector("[data-retention-search]");
  var sort = tool.querySelector("[data-retention-sort]");
  var status = tool.querySelector("[data-retention-status]");
  var selected = new Set();

  function activePanel() {
    var active = document.querySelector(".tab.active, .tab[aria-selected='true'], [role='tab'][aria-selected='true']");
    return (active && active.closest(".tab-panel, [role='tabpanel'], section")) || document.querySelector(".tab-panel:not([hidden]), [role='tabpanel']:not([hidden])");
  }

  function rows(panel) {
    if (!panel) return [];
    return Array.prototype.filter.call(panel.querySelectorAll("tr, .card, .list-item, .item, .row"), function (row) {
      return !row.closest("[data-retention-tools]") && row.textContent.trim().length > 0;
    });
  }

  function refresh() {
    var list = rows(activePanel());
    var query = (search.value || "").trim().toLowerCase();
    var direction = sort.value || "default";
    list.forEach(function (row) {
      row.hidden = Boolean(query) && row.textContent.toLowerCase().indexOf(query) === -1;
      if (!row.querySelector("[data-retention-select]") && !row.querySelector("input[type='checkbox']")) {
        var label = document.createElement("label");
        label.className = "retention-select";
        label.innerHTML = "<input type='checkbox' data-retention-select aria-label='Select row'>";
        row.insertBefore(label, row.firstChild);
      }
    });
    if (direction !== "default") {
      list.sort(function (a, b) {
        var result = a.textContent.trim().localeCompare(b.textContent.trim(), undefined, { numeric: true, sensitivity: "base" });
        return direction === "za" ? -result : result;
      }).forEach(function (row) { if (row.parentElement) row.parentElement.appendChild(row); });
    }
    status.textContent = list.filter(function (row) { return !row.hidden; }).length + " visible";
  }

  tool.addEventListener("input", refresh);
  tool.addEventListener("change", function (event) {
    if (event.target.matches("[data-retention-select]")) {
      var row = event.target.closest("tr, .card, .list-item, .item, .row");
      if (event.target.checked) selected.add(row); else selected.delete(row);
    }
    refresh();
  });
  tool.querySelector("[data-retention-select-visible]").addEventListener("click", function () {
    rows(activePanel()).forEach(function (row) {
      if (!row.hidden) {
        var checkbox = row.querySelector("[data-retention-select]");
        if (checkbox) { checkbox.checked = true; selected.add(row); }
      }
    });
    status.textContent = selected.size + " selected";
  });
  tool.querySelector("[data-retention-clear]").addEventListener("click", function () {
    selected.forEach(function (row) {
      var checkbox = row.querySelector("[data-retention-select]");
      if (checkbox) checkbox.checked = false;
    });
    selected.clear();
    status.textContent = "Selection cleared";
  });
  document.querySelectorAll(".tab, [role='tab']").forEach(function (tab) { tab.addEventListener("click", function () { window.setTimeout(refresh, 0); }); });
  refresh();
  window.setInterval(refresh, 10000);
}());
