function SaveSlotBar({ saves, busy, onSwitch, onCreate }) {
  if (!saves || saves.slots.length === 0) return null;
  return (
    <div className="save-slot-bar">
      <span className="save-slot-label">存档槽位</span>
      <select
        value={saves.activeSlotId}
        disabled={busy}
        onChange={(event) => onSwitch(event.target.value)}
        aria-label="切换存档槽位"
      >
        {saves.slots.map((slot) => (
          <option key={slot.id} value={slot.id}>
            {slot.name} · 第 {slot.day ?? '?'} 日{slot.phase && slot.phase !== 'planning' ? ' · 已完结' : ''}
          </option>
        ))}
      </select>
      <button type="button" onClick={onCreate} disabled={busy}>新存档</button>
    </div>
  );
}

export default SaveSlotBar;
