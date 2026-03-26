const meses = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"
];

const diasSemana = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

// cargar selects
function init() {
  const mesDesde = document.getElementById("mesDesde");
  const mesHasta = document.getElementById("mesHasta");
  const anio = document.getElementById("anio");

  meses.forEach((m, i) => {
    mesDesde.innerHTML += `<option value="${i}">${m}</option>`;
    mesHasta.innerHTML += `<option value="${i}">${m}</option>`;
  });

  for (let y = 2024; y <= 2030; y++) {
    anio.innerHTML += `<option value="${y}">${y}</option>`;
  }

  anio.value = new Date().getFullYear();
}

init();

function generar() {
  const desde = parseInt(mesDesde.value);
  const hasta = parseInt(mesHasta.value);
  const anioVal = parseInt(anio.value);
  const valorBase = parseFloat(document.getElementById("valorBase").value || 0);

  const tbody = document.querySelector("#tabla tbody");
  tbody.innerHTML = "";

  let total = 0;
  let conteo = 0;
  let conteoPorMes = {};

  for (let mes = desde; mes <= hasta; mes++) {
    conteoPorMes[mes] = 0;

    let fecha = new Date(anioVal, mes, 1);

    while (fecha.getMonth() === mes) {
      let dia = fecha.getDay();

      if (dia === 3 || dia === 0) { // miércoles o domingo
        conteo++;
        conteoPorMes[mes]++;

        const fechaStr = fecha.toLocaleDateString("es-AR");

        const row = document.createElement("tr");
        row.classList.add("dia");

        row.innerHTML = `
          <td>${fechaStr}</td>
          <td>${diasSemana[dia]}</td>
          <td><input type="number" class="valor" placeholder="(base ${valorBase})"></td>
          <td class="efectivo">${valorBase}</td>
        `;

        tbody.appendChild(row);
      }

      fecha.setDate(fecha.getDate() + 1);
    }
  }

  // recalcular
  document.querySelectorAll(".valor").forEach(input => {
    input.addEventListener("input", recalcular);
  });

  function recalcular() {
    total = 0;

    document.querySelectorAll("#tabla tbody tr").forEach(row => {
      const input = row.querySelector(".valor");
      const efectivo = row.querySelector(".efectivo");

      let val = input.value ? parseFloat(input.value) : valorBase;
      efectivo.textContent = val;

      total += val;
    });

    document.getElementById("totalFinal").textContent =
      "Total: $" + total.toLocaleString();
  }

  recalcular();

  // resumen
  let html = `<h3>Total sorteos: ${conteo}</h3>`;

  for (let m in conteoPorMes) {
    html += `<div>${meses[m]}: ${conteoPorMes[m]} sorteos</div>`;
  }

  document.getElementById("resumen").innerHTML = html;
}
